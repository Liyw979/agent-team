#!/usr/bin/env python3

"""Simple addition tool."""

from __future__ import annotations

import argparse


def add(a: float, b: float) -> float:
    """Return the sum of ``a`` and ``b``."""
    return a + b


def main() -> None:
    parser = argparse.ArgumentParser(description="Print the sum of two numbers.")
    parser.add_argument("a", type=float, help="First number")
    parser.add_argument("b", type=float, help="Second number")
    args = parser.parse_args()

    print(add(args.a, args.b))


if __name__ == "__main__":
    main()
