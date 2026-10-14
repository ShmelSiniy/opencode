export * as DesktopFiles from "./index"

import { execFile, spawn } from "node:child_process"
import { BrowserWindow, clipboard, dialog, nativeImage, shell } from "electron"
import type { MessageBoxOptions } from "electron"
import { Context, Effect, FileSystem, Layer, Path } from "effect"
import type { DirectoryPickerOptions, FilePickerOptions, SaveFilePickerOptions } from "../../shared/ipc-contract"
import { scoped } from "../native/logging"
import { nativeT } from "../native/translations"
import { assertAttachmentBudget, createPickedFileAuthorizations, readAttachment } from "./attachment-picker"
import { resolveExternalURL, resolveLocalFilePath } from "./external-url"

export type Interface = ReturnType<typeof make>

export class Service extends Context.Service<Service, Interface>()("opencode/desktop/DesktopFiles") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path

    return Service.of(make(fs, path))
  }),
)

function make(fs: FileSystem.FileSystem, path: Path.Path) {
  const pickedFiles = createPickedFileAuthorizations((file, maxBytes) =>
    readAttachment(file, maxBytes).pipe(Effect.provideService(FileSystem.FileSystem, fs)),
  )

  return {
    openDirectoryPicker: Effect.fn("DesktopFiles.openDirectoryPicker")(function* (options?: DirectoryPickerOptions) {
      const result = yield* Effect.promise(() =>
        dialog.showOpenDialog({
          properties: ["openDirectory", ...(options?.multiple ? ["multiSelections" as const] : []), "createDirectory"],
          title: options?.title ?? nativeT("desktop.dialog.chooseFolder"),
          defaultPath: options?.defaultPath,
        }),
      )

      if (result.canceled) return null

      return options?.multiple ? result.filePaths : result.filePaths[0]
    }),
    openFilePicker: Effect.fn("DesktopFiles.openFilePicker")(function* (sender: number, options?: FilePickerOptions) {
      const result = yield* Effect.promise(() =>
        dialog.showOpenDialog({
          properties: ["openFile", ...(options?.multiple ? ["multiSelections" as const] : [])],
          title: options?.title ?? nativeT("desktop.dialog.chooseFile"),
          defaultPath: options?.defaultPath,
          filters: pickerFilters(options?.extensions),
        }),
      )

      if (result.canceled) return null

      const files = yield* Effect.forEach(
        result.filePaths,
        Effect.fnUntraced(function* (file) {
          const info = yield* fs.stat(file)

          return { path: file, name: path.basename(file), size: Number(info.size) }
        }),
        { concurrency: "unbounded" },
      )

      assertAttachmentBudget(files)

      return { token: pickedFiles.add(sender, result.filePaths), files }
    }),
    readPickedFile: pickedFiles.read,
    releasePickedFiles: pickedFiles.release,
    saveFile: Effect.fn("DesktopFiles.saveFile")(function* (options: SaveFilePickerOptions, content: string) {
      const result = yield* Effect.promise(() =>
        dialog.showSaveDialog({
          title: options?.title ?? nativeT("desktop.dialog.saveFile"),
          defaultPath: options?.defaultPath,
        }),
      )

      if (result.canceled) return false

      if (!result.filePath) return false
      yield* fs.writeFile(result.filePath, new TextEncoder().encode(content))

      return true
    }),
    openPath: Effect.fn("DesktopFiles.openPath")(function* (target: string, application?: string) {
      if (!application) return yield* Effect.promise(() => shell.openPath(target))

      if (process.platform !== "darwin" && isShell(application)) {
        // A shell takes the directory as its working directory, not as a positional argument, and it
        // has to outlive the call: execFile would never settle while the terminal window is open.
        const shells = yield* Effect.promise(() => detectShells())
        // Windows always ships 5.1 and may also have PowerShell 7, so ask which one to start.
        const chosen =
          shells.length > 1 ? yield* Effect.promise(() => chooseShell(target, shells)) : (shells[0] ?? undefined)

        if (!chosen) return

        yield* Effect.tryPromise(
          () =>
            new Promise<void>((resolve, reject) => {
              const child = spawn(chosen.file, ["-NoExit"], {
                cwd: target,
                detached: true,
                stdio: "ignore",
              })

              child.once("spawn", () => {
                child.unref()
                resolve()
              })
              child.once("error", reject)
            }),
        )

        return
      }

      yield* Effect.tryPromise(() =>
        new Promise<void>((resolve, reject) => {
          const command =
            process.platform === "darwin"
              ? { file: "open", arguments: ["-a", application, target] }
              : { file: application, arguments: [target] }

          execFile(command.file, command.arguments, (error) => (error ? reject(error) : resolve()))
        }),
      )
    }),
    revealPath: Effect.fn("DesktopFiles.revealPath")(function* (target: string) {
      const exists = yield* fs.exists(target).pipe(Effect.orElseSucceed(() => false))

      if (!exists) return false
      shell.showItemInFolder(target)

      return true
    }),
    readClipboardImage: Effect.fn("DesktopFiles.readClipboardImage")(function* () {
      const items = yield* Effect.promise(() => clipboard.read())

      const found = clipboardImageTypes
        .flatMap((mime) => items.filter((item) => item.types.includes(mime)).map((item) => ({ item, mime })))
        .at(0)

      if (!found) return null
      // getType() is typed as Blob | ClipboardBookmark; only the bookmark format yields the latter.
      const payload = yield* Effect.promise(async () => found.item.getType(found.mime))

      if (!(payload instanceof Blob)) return null
      const bytes = yield* Effect.promise(() => payload.arrayBuffer())
      // Re-encode through nativeImage so the renderer always receives PNG and the image dimensions.
      const image = nativeImage.createFromBuffer(Buffer.from(bytes))

      if (image.isEmpty()) return null
      const size = image.getSize()

      return { buffer: new Uint8Array(image.toPNG()), width: size.width, height: size.height }
    }),
    writeClipboardText: Effect.fn("DesktopFiles.writeClipboardText")(function* (text: string) {
      yield* Effect.promise(() => clipboard.writeText(text))
    }),
  }
}

// Chromium exposes copied bitmaps as image/png; JPEG only appears when an app placed one explicitly.
const clipboardImageTypes = ["image/png", "image/jpeg"]

const isShell = (application: string) => /(^|[\\/])(powershell|pwsh)(\.exe)?$/i.test(application)

type ShellChoice = { label: string; file: string }

// Windows ships the inbox 5.1 as `powershell` and PowerShell 7 as `pwsh` when it is installed, so the
// installed versions are resolved with `where` instead of assuming one of them.
const WINDOWS_SHELLS = [
  { command: "powershell", label: "Windows PowerShell 5.1" },
  { command: "pwsh", label: "PowerShell 7" },
]

function whereExecutables(command: string) {
  return new Promise<string[]>((resolve) => {
    execFile("where", [command], { windowsHide: true }, (error, stdout) => {
      if (error) return resolve([])

      resolve(
        stdout
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter((line) => /\.exe$/i.test(line)),
      )
    })
  })
}

async function detectShells() {
  const found: ShellChoice[] = []

  for (const candidate of WINDOWS_SHELLS) {
    for (const file of await whereExecutables(candidate.command)) {
      if (found.some((shell) => shell.file.toLowerCase() === file.toLowerCase())) continue

      found.push({ file, label: candidate.label })
    }
  }

  return found
}

// Asks which shell to start when more than one is installed. The labels and the body are English only
// for now: the native catalogs are keyed and adding keys belongs to the main repository.
async function chooseShell(target: string, shells: ShellChoice[]) {
  const options: MessageBoxOptions = {
    type: "question",
    noLink: true,
    buttons: [...shells.map((shell) => shell.label), "Cancel"],
    defaultId: 0,
    cancelId: shells.length,
    title: "Open in PowerShell",
    message: "Which PowerShell should open this folder?",
    detail: `${target}\n\n${shells
      .map((shell, index) => `${index + 1}. ${shell.label} - ${shell.file}`)
      .join("\n")}\n\nThe chosen shell opens in that folder and stays open.`,
  }
  const parent = BrowserWindow.getFocusedWindow()
  const result = parent ? await dialog.showMessageBox(parent, options) : await dialog.showMessageBox(options)

  return shells[result.response]
}

export const openExternalURL = Effect.fn("DesktopFiles.openExternalURL")(function* (value: string) {
  const url = resolveExternalURL(value)

  if (!url) {
    yield* scoped("window", Effect.logWarning("blocked external target", { url: value }))

    return false
  }

  return yield* Effect.tryPromise(() => shell.openExternal(url)).pipe(
    Effect.as(true),
    Effect.catch((error) =>
      scoped("window", Effect.logError("failed to open external target", { url, error })).pipe(Effect.as(false)),
    ),
  )
})

export const openLocalFileURL = Effect.fn("DesktopFiles.openLocalFileURL")(function* (value: string) {
  const path = resolveLocalFilePath(value)

  if (!path) {
    yield* scoped("window", Effect.logWarning("blocked local file target", { url: value }))

    return
  }

  const error = yield* Effect.promise(() => shell.openPath(path))

  if (error) yield* scoped("window", Effect.logError("failed to open local file", { path, error }))
})

function pickerFilters(extensions?: string[]) {
  if (!extensions?.length) return undefined

  return [{ name: nativeT("desktop.dialog.files"), extensions }]
}
