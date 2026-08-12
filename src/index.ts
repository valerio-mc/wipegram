import { Box, Text, createCliRenderer } from "@opentui/core"

const renderer = await createCliRenderer({
  screenMode: "alternate-screen",
  exitOnCtrlC: true,
  consoleMode: "disabled",
  openConsoleOnError: false,
  backgroundColor: "#101317",
})

renderer.setTerminalTitle("wipegram")
renderer.root.add(
  Box(
    {
      width: "100%",
      height: "100%",
      alignItems: "center",
      justifyContent: "center",
      flexDirection: "column",
    },
    Text({ content: "wipegram", fg: "#d5f36b" }),
    Text({ content: "Private Telegram cleanup", fg: "#77808c" }),
  ),
)
