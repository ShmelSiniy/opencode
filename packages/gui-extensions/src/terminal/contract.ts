import { Contract, type MountedSession } from "../sdk"

export interface Terminal {
  /** Opens a new terminal tab in the session's dock, starting in the session's directory. */
  open(session: MountedSession): void
}

/** The terminal extension provides this. Inactive while the extension is off. */
export const Terminal = Contract.define<Terminal, "terminal">("terminal")
