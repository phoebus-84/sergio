"""A way over a floor, round what stands on it.

Imported by stage-shot.py. Nothing here knows Blender: a place is (x, y) and
the caller says what stands at one, with `look(place, height)`: the height
of the floor there for a body that comes from a floor at `height`, the name
of what is in its way there or None, and how many times its length a way
over that place counts (1, or more where a body would rather not walk: the
edge of a step).

The straight way is tried first and kept when it is free. Otherwise the
floor is laid out in squares from where the body starts and the shortest
way over the free ones is found, then pulled straight between its corners.
"""
import heapq
import math

# The squares about one: across, then cornerwise.
AROUND = ((1, 0), (-1, 0), (0, 1), (0, -1), (1, 1), (1, -1), (-1, 1), (-1, -1))
# No more squares than this are looked at for one way.
SQUARES = 40000


class NoWay(Exception):
    """There is no way. `met` names what stands in the straight one."""

    def __init__(self, met):
        super().__init__(", ".join(met))
        self.met = met


def along(a, b, step):
    """Places from a to b, both among them, no further apart than `step`."""
    count = max(1, math.ceil(math.dist(a, b) / step))
    return [(a[0] + (b[0] - a[0]) * i / count, a[1] + (b[1] - a[1]) * i / count) for i in range(count + 1)]


def straight(a, b, height, look, step):
    """The straight way from a to b for a body that stands at `height` on a:
    (its places with the floor's height at each, None), or (None, what stands in it).
    Where it starts is not looked at: the body is there already."""
    places = along(a, b, step)
    walked = [(places[0][0], places[0][1], height)]
    for place in places[1:]:
        height, what, _toll = look(place, height)
        if what is not None:
            return None, what
        walked.append((place[0], place[1], height))
    return walked, None


def met_on(a, b, height, look, step):
    """Everything that stands in the straight way, in the order it is come to."""
    met = []
    for place in along(a, b, step)[1:]:
        found, what, _toll = look(place, height)
        if what is None:
            height = found
        elif what not in met:
            met.append(what)
    return met


def squares(a, b, height, look, size, margin):
    """The shortest way from a to b over squares of `size` laid from a, no further than `margin`
    from the two: the squares' places with a and b at its ends, or None when there is none."""
    goal = (round((b[0] - a[0]) / size), round((b[1] - a[1]) / size))
    if goal == (0, 0):
        return [a, b]
    reach = math.ceil(margin / size)
    low = (min(0, goal[0]) - reach, min(0, goal[1]) - reach)
    high = (max(0, goal[0]) + reach, max(0, goal[1]) + reach)

    def place(square):
        return (a[0] + square[0] * size, a[1] + square[1] * size)

    def left(square):
        return math.hypot(goal[0] - square[0], goal[1] - square[1]) * size

    # A square is looked at once, from the first that comes to it: (height, what stands there, what it counts).
    known = {(0, 0): (height, None, 1.0)}

    def at(square, come_from):
        if square not in known:
            # Where it is going is free, whatever its square's middle says: the caller looked there.
            known[square] = look(place(square), come_from) if square != goal else (look(b, come_from)[0], None, 1.0)
        return known[square]

    cost = {(0, 0): 0.0}
    came = {}
    heap = [(left((0, 0)), 0.0, (0, 0))]
    while heap and len(known) < SQUARES:
        _guess, so_far, square = heapq.heappop(heap)
        if square == goal:
            found = [square]
            while found[-1] in came:
                found.append(came[found[-1]])
            found.reverse()
            return [a] + [place(s) for s in found[1:-1]] + [b]
        if so_far > cost[square]:
            continue
        here = known[square][0]
        for dx, dy in AROUND:
            to = (square[0] + dx, square[1] + dy)
            if not (low[0] <= to[0] <= high[0] and low[1] <= to[1] <= high[1]):
                continue
            if at(to, here)[1] is not None:
                continue
            # Cornerwise only between two free squares: a body does not cut a corner of what stands there.
            if dx and dy and (at((square[0] + dx, square[1]), here)[1] is not None or at((square[0], square[1] + dy), here)[1] is not None):
                continue
            further = so_far + math.hypot(dx, dy) * size * known[to][2]
            if further < cost.get(to, math.inf):
                cost[to] = further
                came[to] = square
                heapq.heappush(heap, (further + left(to), further, to))
    return None


def corners(places):
    """The places where a way over squares turns, with its two ends."""
    kept = [places[0]]
    for before, here, after in zip(places, places[1:], places[2:]):
        one = (round(here[0] - before[0], 6), round(here[1] - before[1], 6))
        other = (round(after[0] - here[0], 6), round(after[1] - here[1], 6))
        if one[0] * other[1] - one[1] * other[0] or one[0] * other[0] + one[1] * other[1] <= 0:
            kept.append(here)
    kept.append(places[-1])
    return kept


def find(a, b, height, look, size, margin):
    """The way from a to b for a body that stands at `height` on a.

    Returns (walked, turns, met): the way as places (x, y, floor) no further apart than half a
    square; where it turns, its ends among them; and what stood in the straight way, in the
    order it was come to (nothing, when the way is straight). Raises NoWay when there is none.
    """
    step = size / 2
    walked, what = straight(a, b, height, look, step)
    if walked is not None:
        return walked, [a, b], []
    met = met_on(a, b, height, look, step)
    over = squares(a, b, height, look, size, margin)
    if over is None:
        raise NoWay(met)
    turns = corners(over)
    # From each corner, straight to the furthest later one that is free to go to.
    walked, pulled, index = [(a[0], a[1], height)], [a], 0
    while index < len(turns) - 1:
        for later in range(len(turns) - 1, index, -1):
            leg, _what = straight(turns[index], turns[later], height, look, step)
            if leg is not None:
                break
        else:
            # Its next corner is a square away over free squares: gone to as it is.
            later = index + 1
            leg = [walked[-1]]
            for place in along(turns[index], turns[later], step)[1:]:
                found, blocked, _toll = look(place, height)
                height = found if blocked is None else height
                leg.append((place[0], place[1], height))
        walked += leg[1:]
        height = walked[-1][2]
        pulled.append(turns[later])
        index = later
    return walked, pulled, met
