# {{unit.title}} — rain-soaked neon city

**What happens.** {{unit.idea}}

## The look
A neon megacity at night, built in code with three.js. Instanced towers with
interior-mapped lit rooms, glowing signs in {{palette.sign-a.name}}
({{palette.sign-a}}) and {{palette.sign-b.name}} ({{palette.sign-b}}) made of
invented glyphs, {{palette.warm.name}} street light, wet streets with a planar
reflection pass, {{camera.rain}} rain and steam. Grade: shadows toward
{{palette.shadow}}, blacks at {{palette.night}}.

## How it is built
An HDR pipeline: dual-filter bloom ({{lens.bloom}}), anamorphic streaks
({{lens.streaks}}), motion blur, {{lens.aberration}} of chromatic aberration,
raindrops on the lens ({{lens.raindrops}}), {{lens.grain}} grain. Every frame
is a pure function of the frame number.

## How it moves
One designed camera move: {{camera.move}}.

## Sound
{{sound.music}} {{sound.effects}}

## Never
Real words or real brands on the signs, a city that can be named.
