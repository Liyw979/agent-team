import subprocess
import sys
import unittest
from pathlib import Path

from scripts.add_tool import add


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "add_tool.py"


class AddToolTests(unittest.TestCase):
    def test_add_returns_sum(self):
        # Verifies integer inputs are summed correctly.
        self.assertEqual(3.0, add(1, 2))

    def test_add_handles_floats(self):
        # Verifies float inputs are summed correctly.
        self.assertEqual(4.0, add(1.5, 2.5))

    def test_cli_prints_sum(self):
        # Verifies the CLI prints the computed sum.
        result = subprocess.run(
            [sys.executable, str(SCRIPT), "1", "2"],
            check=True,
            capture_output=True,
            text=True,
        )

        self.assertEqual("3.0\n", result.stdout)

    def test_cli_rejects_non_numeric_input(self):
        # Verifies argparse rejects non-numeric input.
        result = subprocess.run(
            [sys.executable, str(SCRIPT), "a", "2"],
            capture_output=True,
            text=True,
        )

        self.assertNotEqual(0, result.returncode)
        self.assertIn("invalid float value", result.stderr)

    def test_cli_rejects_missing_argument(self):
        # Verifies argparse rejects missing arguments.
        result = subprocess.run(
            [sys.executable, str(SCRIPT), "1"],
            capture_output=True,
            text=True,
        )

        self.assertNotEqual(0, result.returncode)
        self.assertIn("the following arguments are required: b", result.stderr)

    def test_cli_rejects_extra_argument(self):
        # Verifies argparse rejects extra arguments.
        result = subprocess.run(
            [sys.executable, str(SCRIPT), "1", "2", "3"],
            capture_output=True,
            text=True,
        )

        self.assertNotEqual(0, result.returncode)
        self.assertIn("unrecognized arguments: 3", result.stderr)


if __name__ == "__main__":
    unittest.main()
