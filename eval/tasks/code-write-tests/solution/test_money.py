import unittest
from money import split_bill


class T(unittest.TestCase):
    def test_even(self):
        self.assertEqual(split_bill(900, 3), [300, 300, 300])

    def test_remainder_first(self):
        self.assertEqual(split_bill(1000, 3), [334, 333, 333])
        self.assertEqual(split_bill(11, 4), [3, 3, 3, 2])

    def test_sum_and_spread(self):
        for t in range(0, 50):
            for n in range(1, 7):
                s = split_bill(t, n)
                self.assertEqual(sum(s), t); self.assertEqual(len(s), n)
                self.assertLessEqual(max(s) - min(s), 1)
                self.assertEqual(s, sorted(s, reverse=True))

    def test_errors(self):
        for args in [(10, 0), (10, -1), (-1, 2)]:
            with self.assertRaises(ValueError):
                split_bill(*args)
