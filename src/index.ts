import { createCliRenderer } from "@opentui/core"
import { WipegramApp } from "./ui"

const renderer = await createCliRenderer({
  screenMode: "alternate-screen",
  exitOnCtrlC: false,
  consoleMode: "disabled",
  openConsoleOnError: false,
  backgroundColor: "#101317",
})

const app = new WipegramApp(renderer)
await app.start()
