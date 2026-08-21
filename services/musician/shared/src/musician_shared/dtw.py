"""Dynamic time warping over interval sequences.

## Why DTW is correct here and forbidden in the Judge

The Judge compares a transcription against the audio it was derived from. Those
two share a timeline by construction, so warping them would hide the rhythm
distortion the Judge exists to catch -- it would let a badly-timed transcription
score well by stretching it back into place.

The Musician is *deliberately allowed* to alter timing while keeping the tune.
"Is this still the user's idea, played differently?" is exactly the question DTW
answers. Same technique, opposite reason.

Implemented directly rather than pulled from a library: the cost is one small
function, it keeps the shared package dependency-free so both the API container
and the tests can import it, and a warping path over a few dozen intervals is
not where a numerical library earns its place.
"""

from __future__ import annotations

from collections.abc import Sequence

#: Beyond an octave, "how far apart" stops discriminating usefully -- a 13th and
#: a 15th are both simply a large leap. Clamping keeps one wild outlier from
#: dominating the whole distance.
_MAX_INTERVAL_COST = 12.0


def _cost(a: int, b: int) -> float:
    return min(abs(a - b), _MAX_INTERVAL_COST)


def dtw_distance(left: Sequence[int], right: Sequence[int]) -> float:
    """Normalised warping distance between two interval sequences.

    Returns 0.0 for identical sequences and grows with dissimilarity. Normalised
    by path length so that a long melody and a short one are comparable.
    """
    if not left and not right:
        return 0.0
    if not left or not right:
        return _MAX_INTERVAL_COST

    rows, cols = len(left), len(right)
    infinity = float("inf")

    # Two rolling rows: the full matrix is never needed, only the distance.
    previous = [infinity] * (cols + 1)
    previous[0] = 0.0

    for i in range(1, rows + 1):
        current = [infinity] * (cols + 1)
        for j in range(1, cols + 1):
            step = _cost(left[i - 1], right[j - 1])
            current[j] = step + min(previous[j], current[j - 1], previous[j - 1])
        previous = current

    # Path length is bounded below by the longer sequence; using it as the
    # divisor keeps the result in interval-cost units rather than growing with
    # however many steps the path happened to take.
    return previous[cols] / max(rows, cols)


def dtw_similarity(left: Sequence[int], right: Sequence[int]) -> float:
    """:func:`dtw_distance` mapped to 1.0 (identical) .. 0.0 (unrelated)."""
    return max(0.0, 1.0 - dtw_distance(left, right) / _MAX_INTERVAL_COST)
