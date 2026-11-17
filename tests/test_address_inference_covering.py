from address_inference import dataset


def test_a_borrowed_range_does_not_beat_a_real_one_of_similar_size():
    # Washington Avenue, Harpswell: a 50 m piece with only even 24-2 borrows odd 23-1 (FILL_MISSING_SIDE);
    # the real odd range 25-1 is on the piece where 13-21 actually are.
    real = {"tlid": "78071115", "lfromadd": "32", "ltoadd": "26", "rfromadd": "25", "rtoadd": "1"}
    short = {"tlid": "78040255", "lfromadd": "24", "ltoadd": "2", "rfromadd": None, "rtoadd": None}
    dataset.fill_missing_sides([short])
    old = dataset.BORROWED_WIN_FACTOR
    try:
        dataset.BORROWED_WIN_FACTOR = None
        assert dataset.covering_range(17, [real, short])[0]["tlid"] == "78040255"  # tightest (borrowed) won
        dataset.BORROWED_WIN_FACTOR = 3
        assert dataset.covering_range(17, [real, short])[0]["tlid"] == "78071115"  # the real range wins now
        # Basin Point Road: the real odd range runs 1-299 over 600 m -> the borrowed one still wins
        loose = {"tlid": "basin", "lfromadd": None, "ltoadd": None, "rfromadd": "1", "rtoadd": "299"}
        assert dataset.covering_range(17, [loose, short])[0]["tlid"] == "78040255"
    finally:
        dataset.BORROWED_WIN_FACTOR = old
