#!/usr/bin/env python3
"""
A tiny utility script that reads two numbers and prints their difference (a - b).

Usage:
  python main2.py 2 3
  echo -e "2\n3" | python main2.py

Notes:
- If two CLI arguments are provided, they are used as a and b.
- If no arguments are provided, the script reads two lines from stdin.
- Output is the numeric result only (no extra text), followed by a newline.
"""

from __future__ import annotations

import argparse
import sys
from typing import List


def _parse_number(value: str) -> float:
    """Parse a string into a number (int/float). Raises ValueError on invalid input."""
    s = value.strip()
    if s == "":
        raise ValueError("empty input")
    # Use float for broad compatibility (supports ints, decimals, scientific notation).
    return float(s)


def _print_error(message: str) -> None:
    """Print an error message to stderr."""
    sys.stderr.write(f"Error: {message}\n")


def _read_two_numbers_from_stdin() -> List[float]:
    """Read two numbers from standard input."""
    # Avoid interactive prompts so the script works in pipelines and CI.
    try:
        first = sys.stdin.readline()
        if first == "":
            raise ValueError("expected 2 numbers on stdin, got EOF")
        second = sys.stdin.readline()
        if second == "":
            raise ValueError("expected 2 numbers on stdin, got only 1 line")
        return [_parse_number(first), _parse_number(second)]
    except ValueError as e:
        raise ValueError(str(e)) from e


def _build_parser() -> argparse.ArgumentParser:
    """Create an argparse parser for --help support and consistent usage output."""
    parser = argparse.ArgumentParser(
        prog="main2.py",
        description="Subtract two numbers: compute a - b and print the result.",
        usage="python main2.py <a> <b>",
        add_help=True,
    )
    parser.add_argument(
        "a",
        nargs="?",
        help="Minuend (number to subtract from).",
    )
    parser.add_argument(
        "b",
        nargs="?",
        help="Subtrahend (number to subtract).",
    )
    return parser


# PUBLIC_INTERFACE
def main(argv: List[str] | None = None) -> int:
    """Program entrypoint.

    Args:
        argv: Optional argument vector (excluding program name). If None, uses sys.argv[1:].

    Returns:
        Process exit code: 0 on success, 1 on invalid input/usage.
    """
    parser = _build_parser()
    ns = parser.parse_args(sys.argv[1:] if argv is None else argv)

    try:
        if ns.a is not None and ns.b is not None:
            a = _parse_number(ns.a)
            b = _parse_number(ns.b)
        elif ns.a is None and ns.b is None:
            a, b = _read_two_numbers_from_stdin()
        else:
            raise ValueError(
                "provide either exactly 2 command-line arguments or no arguments (then input 2 numbers via stdin)"
            )

        result = a - b

        # Print as int if it's mathematically an integer (e.g., 5.0 => 5).
        if result.is_integer():
            print(int(result))
        else:
            print(result)

        return 0

    except ValueError as e:
        _print_error(str(e))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
