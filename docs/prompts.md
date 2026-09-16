# Prompts

Some jobs are best handed to an AI agent with a good brief. The **Prompts**
page in the menu keeps those briefs ready: open the **⌄ menu** beside the
`+` button on the tab bar, choose **Help…**, then **Prompts**. Clicking a
prompt **copies it to the clipboard** — paste it into a terminal tab running
your harness (Claude Code, Codex, Gemini CLI, …), or into any chat assistant,
fill in the bracketed blanks, and let it work.

Each prompt is also a page in this Documentation workspace, in the `prompts`
folder, so you can read it, adapt it, or copy just a part.

## Theme a Marp deck and its SVGs

[prompts/theme-marp-deck.md](prompts/theme-marp-deck.md)

A [Marp slide deck](editing-modes.md#present-ctrl4-slide-decks) normally carries its
own colours: the Marp theme paints the slides, and any SVG diagram in them
shows the colours it was drawn with. This prompt converts a deck — the
markdown and every local `.svg` it references — so both follow the app theme
you are presenting in, light or dark, without changing a word or a shape:

- The slides get a `<style>` block that maps the Marp theme's colours onto the
  app's theme variables (with the deck's original colours as fallbacks, so it
  still looks the same exported or in another Marp tool).
- Each SVG gets the same **themable board** contract the app's own vector
  drawings use — a `wb-board` root class and a palette block — and every
  colour is mapped to a palette slot: ink, paper, primary, secondary… Colours
  that carry meaning (a red error path) are left alone. The app bakes the
  live theme into such a file every time it shows it, and re-bakes it when you
  switch themes.

Give the agent the deck's path where the prompt says **[path to the .md
file]**, and check the result by switching themes in Split or Present mode.
