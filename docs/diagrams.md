# Drawings and diagrams

A **drawing tab** is a whiteboard: sketch on it with a pen, or lay out a
proper diagram with shapes, labels and arrows. Either way the result is a
plain `.svg` file that any browser renders and that you can drop into a note
with `![](my-diagram.svg)` — the picture in your note is exactly the picture
you drew.

Make one with **Ctrl+Shift+N → Drawing**, or right-click a folder in the
sidebar and choose the vector drawing. The ribbon swaps to the drawing tools
while a drawing tab is active; the same strip you use for bold and italic is
the toolbar here.

## Tools

| Tool | Key | What it does |
| --- | --- | --- |
| Select | V | Click to select, drag to move, drag a handle to resize, drag on empty board to select several |
| Pen | P | Freehand ink, smoothed as you draw |
| Highlighter | H | A wide, translucent pen |
| Eraser | E | Removes whole strokes and shapes it touches |
| Text | T | Click to type. Enter makes a new line, Ctrl+Enter (or clicking away) finishes |
| Shapes | R O L A | Rectangle, ellipse, line, arrow — and, behind the ⌄, rounded rectangle, diamond, triangle, parallelogram, hexagon, cylinder |

The shape button draws the shape you used last; the ⌄ next to it opens the
full set. Hold **Shift** while dragging a shape to keep it square (a circle
for the ellipse); a line snaps to 45° steps.

Zoom with the mouse wheel or the +/− buttons in the corner; pan with the
middle button, a finger, or the mouse while holding **Space**. On a touch
screen one finger pans and two fingers pinch — unless you turn on "draw with
finger" in the ribbon. A pen always draws.

## Colour and style

The colour swatches and the nib sizes in the ribbon set what the next stroke
or shape looks like. **With something selected, they restyle the selection
instead** — and they light up to show what the selection currently is (nothing
lights up when two selected things disagree).

The **Auto / Fixed** button chooses between two palettes. *Auto* colours
follow your theme: a drawing made with them re-tints itself on a dark theme,
and in a browser it follows the system's light or dark setting. *Fixed*
colours are ordinary named colours that stay exactly as drawn everywhere.

The shape-style menu (◧) holds the rest:

- **Fill** — none, a palette colour, or *Paper*: the board's own colour, so a
  box hides whatever is behind it on a light or a dark board.
- **Outline** — solid, dashed or dotted.
- **Arrow heads** — none, at the end, or at both ends. Choosing a head on a
  line makes it an arrow; choosing none on an arrow makes it a line.
- **Route** — straight, or *elbow* (right-angled bends). See connectors below.

## Labels

**Double-click a shape** to type inside it. The text is centred in the shape
and stays centred when the shape moves or resizes — resizing never stretches
the type. Double-click the label to edit it; select the shape and the label
comes with it. A line or arrow can carry a label too: it sits at the middle
of the line.

Free-standing text (the Text tool) is just text: it has no box and never
wraps, so press Enter where you want a new line.

## Arranging

Right-click the board for the arranging commands, or use the shortcuts:

- **Copy, cut, paste, duplicate** (Ctrl+C / X / V / D). Each repeated paste
  lands a little further along. A copy can be pasted onto another drawing, or
  into any app that accepts SVG text.
- **Bring forward / send backward** (Ctrl+] / Ctrl+[), and **to front / to
  back** with Shift.
- **Align** left, centre, right, top, middle or bottom, and **distribute**
  horizontally or vertically — two or more things selected (three to
  distribute).
- **Group** (Ctrl+G) so several things select and move as one; **ungroup**
  with Ctrl+Shift+G. Groups do not nest — grouping a group with something
  else merges them.
- **Nudge** the selection with the arrow keys (Shift for ten pixels at a
  time). **Delete** removes it.

## The grid and snapping

Press **G** (or the ⊞ button) to show a dot grid. While it shows, shapes,
moves, resizes and text land on it. The ⌄ beside the button sets the spacing
and whether the grid snaps. Each drawing remembers its own grid, and turning
it on or off is never an undo step.

Grid or no grid, things also line up with each other: drag a box near
another box's edge or centre and it lands there, with a thin line showing what
it lined up with. Hold **Alt** while dragging to ignore snapping for that one
drag. Freehand ink never snaps — a pen stroke is the stroke you drew.

## Connectors

Lines and arrows connect things. **Start or finish a line on a shape and it
sticks to it**: from then on, moving or resizing the shape moves the end of
the line with it, and the end always sits on the shape's drawn edge — on the
curve of an ellipse, on the slant of a diamond, not on the invisible box
around them.

Where the line attaches depends on where you press. Near the middle of a side
it attaches to that side's **port** (a selected shape shows its four ports
faintly), and the line leaves the shape squarely from there. Anywhere else it
attaches to the shape as a whole and the end slides around the edge to face
wherever the other end is. While you drag, the shape under the pointer shows
its ports with the one you are about to hit lit up.

**Select a connector and it shows two round handles instead of a resize box.**
Drag a handle onto another shape to re-attach that end, or into empty space to
let go of it. A filled handle is an attached end. **Detach connector** in the
right-click menu lets both ends go at once.

Choose **Elbow** in the shape-style menu or the right-click menu and the
connector runs in right angles — out of one shape along its side's direction,
one or two bends, into the other. Elbows are routed automatically from where
the ends are and which ports they use; there are no bend handles to fiddle
with. **Straight** puts it back.

Deleting a shape does not delete the arrows into it — they stay where they
were, detached, because they were drawn on purpose too. Copying a shape and
its arrow together keeps them attached; copying the arrow alone gives you a
plain arrow.

## Layers, pages and scanning

The ▤ button opens the layers panel: layers stack like sheets of tracing
paper, and each can be hidden, locked, renamed or reordered. New ink lands on
the active layer.

A new drawing is an **infinite board** — the file grows to fit whatever you
draw. The ▢ button adds a page (a fixed white rectangle) around the current
view, or removes it again.

The **Scan** button photographs a physical whiteboard and turns it into
strokes on a new layer — see the scan screen's own hints for cropping and
colour. The ◐ button switches a scanned drawing between theme colours and the
colours the camera actually saw.

## Split: the drawing and its source together

A drawing tab has three modes in the status bar — **Raw** (Ctrl+1), **Split**
(Ctrl+2) and **Draw**. Raw is the `.svg` file as text; Split puts
that text on the left and the board on the right, and both halves are live:
type an attribute in the source and the picture redraws, move a shape on the
board and the markup updates under you. Drag the divider to resize.

The two panes also point at each other:

- **Select something on the board** and its markup is highlighted in the
  source, scrolled into view if it was off screen. Your caret is not moved —
  you can be mid-sentence in the source and still click around the drawing.
- **Put the caret on an element in the source** and that element is selected
  on the board and panned into view. From there the ribbon's colour, nib and
  arrange controls act on it, so "find it in the text, then restyle it" works.
- **Right-click an element → Reveal in source** when you want the caret
  taken there.

While the source is halfway through an edit and not yet valid XML, the board
keeps the last picture it could read, dims it, and says so along the top; it
stops accepting edits of its own until the text parses again, so it can never
overwrite what you are typing. Finish the tag and it picks straight back up.

Undo is per pane: Ctrl+Z in the source undoes typing, Ctrl+Z on the board
undoes drawing. Switching modes starts the board's undo history fresh.

## Keys

Every shortcut is listed under *Drawing tabs* in
[Keyboard shortcuts](keyboard-shortcuts.md).
