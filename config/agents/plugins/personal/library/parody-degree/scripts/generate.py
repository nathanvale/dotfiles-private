#!/usr/bin/env python3
"""Render the packaged parody certificate with installed Times New Roman faces."""

import argparse
from datetime import date, datetime
from io import BytesIO
import json
import os
from pathlib import Path
import sys
import unicodedata
from zoneinfo import ZoneInfo

from reportlab.lib.pagesizes import A3
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen import canvas


SKILL_ROOT = Path(__file__).resolve().parents[1]
FONT_FILES = {
    "italic": ("Times New Roman Italic.ttf", "timesi.ttf"),
    "bold": ("Times New Roman Bold Italic.ttf", "timesbi.ttf"),
}
FONT_NAMES = {
    "italic": "TimesNewRomanPS-ItalicMT",
    "bold": "TimesNewRomanPS-BoldItalicMT",
}


def font_locations(explicit):
    if explicit:
        return [explicit]
    return [
        Path("/System/Library/Fonts/Supplemental"),
        Path.home() / "Library/Fonts",
        Path.home() / ".local/share/fonts",
        Path.home() / ".fonts",
        Path("/usr/share/fonts/truetype/msttcorefonts"),
        Path("/usr/local/share/fonts"),
        Path(os.environ.get("WINDIR", "C:/Windows")) / "Fonts",
    ]


def installed_font(style, locations):
    for folder in locations:
        for filename in FONT_FILES[style]:
            candidate = folder / filename
            if candidate.is_file():
                return candidate
    raise ValueError(
        f"Installed Times New Roman {style} face unavailable. "
        "Use --font-dir with its installed directory; font files are not bundled."
    )


def register_fonts(font_dir):
    locations = font_locations(font_dir)
    for style, expected in FONT_NAMES.items():
        path = installed_font(style, locations)
        font = TTFont(style, str(path))
        if font.face.name.decode("ascii") != expected:
            raise ValueError(f"The installed {style} face is not the approved Times New Roman face.")
        pdfmetrics.registerFont(font)


def single_line(value, field):
    value = unicodedata.normalize("NFC", value.strip())
    if not value or any(unicodedata.category(char).startswith("C") for char in value):
        raise ValueError(f"{field} must be a non-empty single line without control characters.")
    return value


def written_date(value):
    words = {
        1: "first", 2: "second", 3: "third", 4: "fourth", 5: "fifth",
        6: "sixth", 7: "seventh", 8: "eighth", 9: "ninth", 10: "tenth",
        11: "eleventh", 12: "twelfth", 13: "thirteenth", 14: "fourteenth",
        15: "fifteenth", 16: "sixteenth", 17: "seventeenth", 18: "eighteenth",
        19: "nineteenth", 20: "twentieth", 21: "twenty-first", 22: "twenty-second",
        23: "twenty-third", 24: "twenty-fourth", 25: "twenty-fifth",
        26: "twenty-sixth", 27: "twenty-seventh", 28: "twenty-eighth",
        29: "twenty-ninth", 30: "thirtieth", 31: "thirty-first",
    }
    months = ("January February March April May June July August September October November December").split()
    return f"on the {words[value.day]} day of {months[value.month - 1]} {value.year}"


def text_runs(row, values):
    if "runs" in row:
        return row["runs"]
    return [[values[row["field"]] if "field" in row else row["text"], row.get("style", "italic")]]


def checked_rows(layout, values):
    width, height = A3
    source_width, source_height = layout["source_size_pt"]
    rows = []
    for row in layout["text"]:
        style = row.get("style", "italic")
        size_key = "label_size_pt" if style == "label" else "body_size_pt"
        size = layout[size_key] * width / source_width
        runs = [(text, "italic" if face == "label" else face) for text, face in text_runs(row, values)]
        for text, face in runs:
            glyphs = pdfmetrics.getFont(face).face.charWidths
            if any(ord(char) not in glyphs for char in text):
                raise ValueError(f"{row.get('field', 'template')} contains a character unavailable in Times New Roman.")
        measured = sum(pdfmetrics.stringWidth(text, face, size) for text, face in runs)
        available = row.get("max_width", .86) * width
        if measured > available:
            raise ValueError(
                f"{row.get('field', 'template')} overflows its single-line area "
                f"({measured:.2f}pt; maximum {available:.2f}pt). Shorten it; font size is fixed."
            )
        baseline = row["baseline"] * height / source_height
        rows.append((row["centre"] * width - measured / 2, baseline, size, runs))
    return rows


def render(name, degree, certificate_date, font_dir):
    values = {
        "name": single_line(name, "name"),
        "degree": single_line(degree, "degree"),
        "date": written_date(certificate_date),
    }
    register_fonts(font_dir)
    layout = json.loads((SKILL_ROOT / "assets/layout.json").read_text())
    rows = checked_rows(layout, values)
    stream = BytesIO()
    document = canvas.Canvas(stream, pagesize=A3, pageCompression=1, invariant=1)
    document.setTitle(f"Personal parody: {values['degree']}")
    document.setSubject("Humorous personal parody. Not an issued academic qualification.")
    document.setCreator("Personal parody certificate skill")
    width, height = A3
    document.setFillColorRGB(1, 1, 1)
    document.rect(0, 0, width, height, fill=1, stroke=0)
    for item in layout["artwork"]:
        x, y, w, h = item["percent_bounds"]
        document.drawImage(str(SKILL_ROOT / "assets" / item["file"]),
                           x / 100 * width, (1 - (y + h) / 100) * height,
                           w / 100 * width, h / 100 * height, mask="auto")
    document.setFillColorRGB(0, 0, 0)
    for x, y, size, runs in rows:
        for text, face in runs:
            document.setFont(face, size)
            document.drawString(x, y, text)
            x += pdfmetrics.stringWidth(text, face, size)
    document.showPage()
    document.save()
    return stream.getvalue()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--name", required=True, help="Recipient's full name, exactly as supplied.")
    parser.add_argument("--degree", required=True, help="Complete parody degree title; no prefix is added.")
    parser.add_argument("--date", type=date.fromisoformat, help="Override the default Melbourne generation date, YYYY-MM-DD.")
    parser.add_argument("--output", required=True, type=Path, help="New PDF path. Existing files are preserved.")
    parser.add_argument("--font-dir", type=Path, help="Directory containing installed Times New Roman faces.")
    args = parser.parse_args()
    certificate_date = args.date or datetime.now(ZoneInfo("Australia/Melbourne")).date()
    try:
        content = render(args.name, args.degree, certificate_date, args.font_dir)
        args.output.parent.mkdir(parents=True, exist_ok=True)
        with args.output.open("xb") as output:
            output.write(content)
    except (ValueError, OSError) as error:
        parser.exit(2, f"Cannot create PDF: {error}\n")
    print(json.dumps({"status": "created", "output": str(args.output.resolve()), "pages": 1,
                      "page_mm": [297, 420], "certificate_date": certificate_date.isoformat()}))


if __name__ == "__main__":
    main()
