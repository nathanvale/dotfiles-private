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
from pdfminer.pdftypes import resolve1


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
        self.data_file = self.root / "certificate fields.json"
        self.fields = {
            "student_name": "Alex Morgan",
            "conferral_date": "on the eleventh day of November 2026",
            "award_text": "been admitted to the degree of",
            "award_title_line1": "Master of Applied Patience",
            "award_title_line2": "and Extraordinary Snack Management",
            "specialisation_major_title": "with a major in Tea",
            "award_with_distinction": "with high distinction",
        }

    def run_process(self, fields=None, extra=(), env=None):
        self.data_file.write_text(json.dumps(self.fields if fields is None else fields))
        return subprocess.run(
            [sys.executable, str(self.script), "--data", str(self.data_file),
             "--output", str(self.output), *extra], cwd=self.root,
            capture_output=True, text=True, timeout=15, check=False, env=env)

    def test_seven_fields_render_as_requested_with_a3_and_embedded_fonts(self):
        result = self.run_process()
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
            for key, wording in self.fields.items():
                self.assertIn(wording, list(lines))
                bold = key in {"student_name", "award_title_line1", "award_title_line2"}
                self.assertTrue(all(("BoldItalicMT" in c["fontname"]) == bold
                                    for c in lines[wording]["chars"]))
            self.assertNotIn("{{", page.extract_text())
            embedded = []
            for reference in resolve1(page.page_obj.resources["Font"]).values():
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

    def test_blank_optional_lines_collapse_without_fixed_honours(self):
        fields = dict(self.fields, award_title_line2="", specialisation_major_title="",
                      award_with_distinction="with exceptional persistence")
        result = self.run_process(fields)
        self.assertEqual(result.returncode, 0, result.stderr)
        with pdfplumber.open(self.output) as pdf:
            lines = {line["text"]: line for line in pdf.pages[0].extract_text_lines()}
            difference = lines["with exceptional persistence"]["top"] - lines["Master of Applied Patience"]["top"]
            self.assertAlmostEqual(difference, 33, delta=.05)
            self.assertNotIn("with high distinction", lines)
            self.assertNotIn("and first class honours", lines)
            self.assertNotIn("and Extraordinary Snack Management", lines)

    def test_supplied_date_and_award_wording_are_literal(self):
        fields = dict(self.fields, conferral_date="on a wonderfully ordinary Thursday",
                      award_text="been joyfully admitted to the degree of")
        result = self.run_process(fields)
        self.assertEqual(result.returncode, 0, result.stderr)
        with pdfplumber.open(self.output) as pdf:
            text = pdf.pages[0].extract_text()
            self.assertIn("on a wonderfully ordinary Thursday", text)
            self.assertIn("been joyfully admitted to the degree of", text)

    def test_minimal_input_defaults_to_melbourne_date_and_empty_optional_lines(self):
        before = subprocess.run(["date", "+%B %Y"], env={**os.environ, "TZ": "Australia/Melbourne", "LC_ALL": "C"},
                                capture_output=True, text=True, check=True).stdout.strip()
        fields = {"student_name": "Alex Morgan", "award_title_line1": "Master of Applied Patience"}
        result = self.run_process(fields, env={**os.environ, "TZ": "Pacific/Honolulu"})
        after = subprocess.run(["date", "+%B %Y"], env={**os.environ, "TZ": "Australia/Melbourne", "LC_ALL": "C"},
                               capture_output=True, text=True, check=True).stdout.strip()
        self.assertEqual(result.returncode, 0, result.stderr)
        wording = json.loads(result.stdout)["conferral_date"]
        self.assertTrue(any(wording.endswith(month) for month in [before, after]))
        day_words = ["first", "second", "third", "fourth", "fifth", "sixth", "seventh", "eighth", "ninth", "tenth",
                     "eleventh", "twelfth", "thirteenth", "fourteenth", "fifteenth", "sixteenth", "seventeenth",
                     "eighteenth", "nineteenth", "twentieth", "twenty-first", "twenty-second", "twenty-third",
                     "twenty-fourth", "twenty-fifth", "twenty-sixth", "twenty-seventh", "twenty-eighth",
                     "twenty-ninth", "thirtieth", "thirty-first"]
        day = int(subprocess.run(["date", "+%d"], env={**os.environ, "TZ": "Australia/Melbourne"},
                                 capture_output=True, text=True, check=True).stdout.strip())
        self.assertIn("on the " + day_words[day - 1] + " day of ", wording)
        with pdfplumber.open(self.output) as pdf:
            text = pdf.pages[0].extract_text()
            self.assertIn(wording, text)
            self.assertIn("been admitted to the degree of", text)
            self.assertNotIn("high distinction", text)
            self.assertNotIn("first class honours", text)

    def test_missing_required_unknown_or_non_string_fields_reject(self):
        for fields, expected in [({}, "student_name"), ({"student_name": "Alex"}, "award_title_line1"),
                                 (dict(self.fields, degree="Wrong key"), "degree"),
                                 (dict(self.fields, student_name=None), "student_name"),
                                 ([], "JSON object")]:
            with self.subTest(expected=expected):
                result = self.run_process(fields)
                self.assertEqual(result.returncode, 2)
                self.assertIn(expected, result.stderr)
                self.assertEqual(result.stdout, "")
                self.assertFalse(self.output.exists())

    def test_blank_required_multiline_and_unresolved_tokens_reject(self):
        for field, value in [("student_name", " "), ("award_title_line1", ""),
                             ("award_text", ""), ("conferral_date", ""),
                             ("student_name", "Alex\nMorgan"), ("student_name", "{{student_name}}")]:
            with self.subTest(field=field, value=value):
                result = self.run_process(dict(self.fields, **{field: value}))
                self.assertEqual(result.returncode, 2)
                self.assertIn(field, result.stderr)
                self.assertEqual(result.stdout, "")
                self.assertFalse(self.output.exists())

    def test_all_dynamic_fields_detect_overflow_before_output(self):
        for field in self.fields:
            with self.subTest(field=field):
                result = self.run_process(dict(self.fields, **{field: "W" * 200}))
                self.assertEqual(result.returncode, 2)
                self.assertIn(field + " overflows", result.stderr)
                self.assertEqual(result.stdout, "")
                self.assertFalse(self.output.exists())

    def test_missing_glyph_is_reported_instead_of_substituted(self):
        result = self.run_process(dict(self.fields, student_name="Alex \U0001f642"))
        self.assertEqual(result.returncode, 2)
        self.assertIn("character unavailable", result.stderr)
        self.assertFalse(self.output.exists())

    def test_existing_output_is_preserved(self):
        self.output.write_bytes(b"owned-existing-file")
        result = self.run_process()
        self.assertEqual(result.returncode, 2)
        self.assertEqual(self.output.read_bytes(), b"owned-existing-file")

    def test_missing_installed_fonts_reject_without_fallback(self):
        empty_fonts = self.root / "empty fonts"
        empty_fonts.mkdir()
        result = self.run_process(extra=["--font-dir", str(empty_fonts)])
        self.assertEqual(result.returncode, 2)
        self.assertIn("Installed Times New Roman", result.stderr)
        self.assertFalse(self.output.exists())

    def test_malformed_json_rejects_cleanly(self):
        self.data_file.write_text("{")
        result = subprocess.run([sys.executable, str(self.script), "--data", str(self.data_file),
                                 "--output", str(self.output)], capture_output=True, text=True, check=False)
        self.assertEqual(result.returncode, 2)
        self.assertEqual(result.stdout, "")
        self.assertNotIn("Traceback", result.stderr)
        self.assertFalse(self.output.exists())


if __name__ == "__main__":
    unittest.main()
