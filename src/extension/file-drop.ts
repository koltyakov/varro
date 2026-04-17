import * as vscode from "vscode"
import { logger } from "./logger"

export class FileDropController {
  private sidebar: {
    postDroppedFiles: (
      files: Array<{ path: string; relativePath: string; type: "file" | "directory" }>,
    ) => void
  }

  constructor(
    sidebar: {
      postDroppedFiles: (
        files: Array<{ path: string; relativePath: string; type: "file" | "directory" }>,
      ) => void
    },
  ) {
    this.sidebar = sidebar
  }

  handleDrop(files: Array<{ path: string; relativePath: string; type: "file" | "directory" }>) {
    logger.info("Files dropped:", files.map((f) => f.relativePath))
    this.sidebar.postDroppedFiles(files)
  }
}
