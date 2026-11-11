"""Public-process proof using a skill copied outside its checkout."""

import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

import pdfplumber


SOURCE = Path(__file__).resolve().parents[1]


class CopiedCertificateTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="degree-skill-copy-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.skill = self.root / "copied skill"
        shutil.copytree(SOURCE, self.skill, ignore=shutil.ignore_patterns("__pycache__"))
        self.script = self.skill / "scripts/generate.py"
        self.output = self.root / "review.pdf"
        self.base = ["--name", "Alex Morgan", "--degree", "Masters of Applied Patience",
                     "--date", "2026-11-11", "--output", str(self.output)]

    def run_process(self, args):
        return subprocess.run([sys.executable, str(self.script), *args], cwd=self.root,
                              capture_output=True, text=True, timeout=15, check=False)

    def test_copied_payload_produces_requested_a3_text_fonts_and_emphasis(self):
        result = self.run_process(self.base)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stderr, "")
        self.assertEqual(json.loads(result.stdout)["status"], "created")
        with pdfplumber.open(self.output) as pdf:
            self.assertEqual(len(pdf.pages), 1)
            page = pdf.pages[0]
            self.assertAlmostEqual(page.width, 841.889764, places=3)
            self.assertAlmostEqual(page.height, 1190.551181, places=3)
            self.assertEqual(len(page.images), 5)
            lines = {line["text"]: line for line in page.extract_text_lines()}
            for expected in ["Alex Morgan", "Masters of Applied Patience",
                             "on the eleventh day of November 2026",
                             "with high distinction", "and first class honours"]:
                self.assertIn(expected, lines)
            for wording, prefix in [("with high distinction", "with "),
                                    ("and first class honours", "and ")]:
                chars = lines[wording]["chars"]
                self.assertTrue(all("ItalicMT" in char["fontname"] and "Bold" not in char["fontname"]
                                    for char in chars[:len(prefix.replace(" ", ""))]))
                self.assertTrue(all("BoldItalicMT" in char["fontname"] for char in chars[len(prefix.replace(" ", "")): ]))
            fonts = page.page_obj.resources["Font"]
            from pdfminer.pdftypes import resolve1
            embedded = []
            for reference in resolve1(fonts).values():
                font = resolve1(reference)
                descriptor = resolve1(font.get("FontDescriptor", {}))
                if "FontFile2" in descriptor:
                    embedded.append(str(font["BaseFont"]))
            self.assertTrue(any("TimesNewRomanPS-ItalicMT" in name for name in embedded))
            self.assertTrue(any("TimesNewRomanPS-BoldItalicMT" in name for name in embedded))
            for char in page.chars:
                self.assertGreaterEqual(char["x0"], 0)
                self.assertLessEqual(char["x1"], page.width)
                self.assertGreaterEqual(char["top"], 0)
                self.assertLessEqual(char["bottom"], page.height)

    def test_overflow_rejects_before_creating_an_output(self):
        for index, field in [(1, "name"), (3, "degree")]:
            with self.subTest(field=field):
                args = self.base.copy()
                args[index] = "W" * 200
                result = self.run_process(args)
                self.assertEqual(result.returncode, 2)
                self.assertIn(field + " overflows", result.stderr)
                self.assertEqual(result.stdout, "")
                self.assertFalse(self.output.exists())

    def test_blank_and_multiline_inputs_reject_before_output(self):
        for index, value in [(1, " "), (3, "\n"), (1, "Alex\nMorgan")]:
            with self.subTest(index=index, value=value):
                args = self.base.copy()
                args[index] = value
                result = self.run_process(args)
                self.assertEqual(result.returncode, 2)
                self.assertIn("non-empty single line", result.stderr)
                self.assertFalse(self.output.exists())

    def test_missing_glyph_is_reported_instead_of_substituted(self):
        args = self.base.copy()
        args[1] = "Alex \U0001f642"
        result = self.run_process(args)
        self.assertEqual(result.returncode, 2)
        self.assertIn("character unavailable", result.stderr)
        self.assertFalse(self.output.exists())

    def test_existing_output_is_preserved(self):
        self.output.write_bytes(b"owned-existing-file")
        result = self.run_process(self.base)
        self.assertEqual(result.returncode, 2)
        self.assertEqual(self.output.read_bytes(), b"owned-existing-file")

    def test_missing_installed_fonts_reject_without_fallback(self):
        empty_fonts = self.root / "empty fonts"
        empty_fonts.mkdir()
        result = self.run_process([*self.base, "--font-dir", str(empty_fonts)])
        self.assertEqual(result.returncode, 2)
        self.assertIn("Installed Times New Roman", result.stderr)
        self.assertFalse(self.output.exists())

    def test_supplied_date_uses_english_ordinal_words(self):
        for value, wording in [("2024-02-29", "on the twenty-ninth day of February 2024"),
                               ("2026-01-01", "on the first day of January 2026")]:
            with self.subTest(date=value):
                args = self.base.copy()
                args[5] = value
                args[-1] = str(self.root / (value + ".pdf"))
                result = self.run_process(args)
                self.assertEqual(result.returncode, 0, result.stderr)
                with pdfplumber.open(args[-1]) as pdf:
                    self.assertIn(wording, pdf.pages[0].extract_text())

    def test_default_date_uses_melbourne_calendar(self):
        before = subprocess.run(["date", "+%Y-%m-%d"],
                                env={**os.environ, "TZ": "Australia/Melbourne"},
                                capture_output=True, text=True, check=True).stdout.strip()
        args = self.base[:4] + self.base[6:]
        result = self.run_process(args)
        after = subprocess.run(["date", "+%Y-%m-%d"],
                               env={**os.environ, "TZ": "Australia/Melbourne"},
                               capture_output=True, text=True, check=True).stdout.strip()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn(json.loads(result.stdout)["certificate_date"], [before, after])

    def test_missing_required_input_is_reported(self):
        result = self.run_process(["--name", "Alex Morgan"])
        self.assertEqual(result.returncode, 2)
        self.assertIn("--degree", result.stderr)
        self.assertFalse(self.output.exists())


if __name__ == "__main__":
    unittest.main()
