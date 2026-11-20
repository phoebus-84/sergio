# {{unit.title}} — risograph print

**What happens.** {{unit.idea}}

## The look
A risograph print animation: bold, simple flat shapes designed so the inks
overlap into new colours. The inks are {{palette}}, on {{palette.paper.name}}
({{palette.paper}}) with tooth. {{palette.yellow.name}} is {{palette.yellow.role}};
{{palette.pink.name}} is {{palette.pink.role}}.

## How it is built
Draw each ink as a greyscale plate on its own canvas, then print them in a
shader: each plate through its own halftone screen ({{print.screen}}),
multiply overprint, {{print.misregistration}} of misregistration that changes
on every print, roller banding ({{print.banding}}), pinholes
({{print.pinholes}}). Every frame is a pure function of the frame number.

## How it moves
Hold each print for {{print.hold}} so the picture jitters like a stack of
prints flipped through. One event, and a final image that uses overprint for
a reveal.

## Sound
{{sound.music}} {{sound.effects}}

## Never
Gradients, text, a colour no overlap of the inks can make.
