import unittest
from report import build_report


class T(unittest.TestCase):
    def test_basic(self):
        out = build_report(1000, 250.5, 100)
        self.assertEqual(out.splitlines()[1], "Income.................1000.00")
        self.assertEqual(out.splitlines()[-1], "Net.....................649.50")

    def test_negative(self):
        self.assertIn("Net.....................-50.00", build_report(10, 50, 10))


if __name__ == "__main__":
    unittest.main()
