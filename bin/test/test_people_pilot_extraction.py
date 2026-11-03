"""Public CLI contract checks, not model trials or pilot evidence units."""

import copy
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


CLI = Path(__file__).resolve().parents[1] / "system/people-pilot-extraction.py"
# Protocol atoms only. These encode no person, event, held-out passage or label.
SOURCE = {"unit_id": "protocol", "speaker": "S", "addressee": "A",
          "source_date": "2000-01-01", "text": "value flag."}
FIELDS = ["family_relationship", "organization", "role", "responsibilities",
          "preferred_channel", "tone", "amount_of_detail", "communication_boundaries"]
VALUE = {"quote": "value", "start": 0, "end": 5}
FLAG = {"quote": "flag", "start": 6, "end": 10}
SUPPORT = {"quote": "value flag.", "start": 0, "end": 11}


def attribution(status):
    return {"status": status, "evidence": [FLAG] if status == "ambiguous" else []}


def primary(status="unambiguous", candidate=False):
    output = {field: {"candidates": [], "missing_reason": "not_stated"} for field in FIELDS}
    output["subject_attribution"] = attribution(status)
    if candidate:
        output["role"] = {"missing_reason": "not_missing", "candidates": [{
            "subject": "S", "speaker": "S", "source_date": "2000-01-01",
            "value_span": VALUE, "supporting_passage": SUPPORT,
            "temporal_qualifiers": {"status_markers": [], "date_limits": []}}]}
    elif status == "ambiguous":
        output["role"]["missing_reason"] = "ambiguous"
    return output


def team(status="unambiguous"):
    return {"subject_attribution": attribution(status), "team_evidence": None,
            "category_word": None, "team_name": None, "subject": "S", "speaker": "S",
            "source_date": "2000-01-01", "supporting_passage": SUPPORT,
            "temporal_qualifiers": {"status_markers": [], "date_limits": []},
            "missing_reason": "not_stated"}


def envelope(content):
    return {"choices": [{"finish_reason": "stop", "message": {"content": json.dumps(content)}}]}


class PeoplePilotExtraction(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.source = self.root / "source.json"
        self.source.write_text(json.dumps(SOURCE))
        self.env = {"PATH": os.defpath, "PYTHONDONTWRITEBYTECODE": "1"}

    def call(self, command, output, first=None, second=None):
        path = self.root / output
        args = [sys.executable, str(CLI), command, "--input", str(self.source), "--output", str(path)]
        for flag, name, value in [("--response", "first.json", first),
                                  ("--team-response", "second.json", second)]:
            if value is not None:
                response = self.root / name
                response.write_text(json.dumps(envelope(value)))
                args.extend([flag, str(response)])
        result = subprocess.run(args, capture_output=True, text=True, env=self.env, timeout=10)
        self.assertEqual(result.stderr, "")
        return result, json.loads(path.read_text()) if path.exists() else None

    def test_prepare_exposes_both_attribution_states_in_independent_requests(self):
        for command in ["prepare", "prepare-team"]:
            with self.subTest(command=command):
                result, request = self.call(command, command + ".json")
                self.assertEqual(result.returncode, 0)
                schema = request["response_format"]["json_schema"]["schema"]
                self.assertEqual({branch["properties"]["subject_attribution"]["properties"]["status"]["const"]
                                  for branch in schema["anyOf"]}, {"unambiguous", "ambiguous"})
                uncertain = next(branch["properties"] for branch in schema["anyOf"]
                                 if branch["properties"]["subject_attribution"]["properties"]["status"]["const"] == "ambiguous")
                self.assertEqual(uncertain["subject_attribution"]["properties"]["evidence"]["minItems"], 1)
                if command == "prepare":
                    for field in FIELDS:
                        self.assertEqual(uncertain[field]["properties"]["candidates"]["maxItems"], 0)
                else:
                    self.assertEqual(uncertain["team_name"], {"type": "null"})
                self.assertEqual(json.loads(request["messages"][1]["content"])["source"], SOURCE)
                self.assertEqual((request["tools"], request["tool_choice"], request["store"]), ([], "none", False))
                self.assertIn("two different people", request["messages"][0]["content"])

    def test_pair_preserves_explicit_ambiguity_and_missing_reasons(self):
        result, output = self.call("validate-pair", "pair.json", primary("ambiguous"), team("ambiguous"))
        self.assertEqual(result.returncode, 0)
        self.assertEqual(output["candidates"], [])
        self.assertEqual(output["subject_attribution"], {"status": "ambiguous", "evidence": [FLAG]})
        self.assertEqual(len(output["missing"]), 9)
        self.assertIn({"subject": "S", "field": "role", "reason": "ambiguous"}, output["missing"])

    def test_pair_preserves_unambiguous_candidate_without_adding_or_trimming(self):
        result, output = self.call("validate-pair", "clear.json", primary(candidate=True), team())
        self.assertEqual(result.returncode, 0)
        self.assertEqual(output["subject_attribution"], {"status": "unambiguous", "evidence": []})
        self.assertEqual(output["candidates"], [{"subject": "S", "speaker": "S", "source_date": "2000-01-01",
                         "field": "role", "quoted_value": "value", "value_start": 0, "value_end": 5,
                         "supporting_passage": SUPPORT, "temporal_qualifiers": []}])
        self.assertEqual(len(output["missing"]), 8)

    def test_ambiguous_candidate_is_rejected_without_salvaging_or_rewriting(self):
        result, output = self.call("validate", "unsafe.json", primary("ambiguous", candidate=True))
        self.assertEqual(result.returncode, 1)
        self.assertIsNone(output)
        self.assertEqual(json.loads(result.stdout)["status"], "failed")

    def test_ambiguous_team_cannot_carry_a_present_name(self):
        unsafe = team("ambiguous")
        unsafe.update(team_evidence=VALUE, team_name=VALUE, missing_reason="not_missing")
        result, output = self.call("validate-team", "team-unsafe.json", unsafe)
        self.assertEqual(result.returncode, 1)
        self.assertIsNone(output)

    def test_pair_disagreement_is_an_error_not_a_partial_candidate_result(self):
        for index, (first, second) in enumerate([(primary("ambiguous"), team()), (primary(candidate=True), team("ambiguous"))]):
            with self.subTest(index=index):
                result, output = self.call("validate-pair", f"disagreement-{index}.json", first, second)
                self.assertEqual(result.returncode, 1)
                self.assertIsNone(output)

    def test_invalid_attribution_evidence_is_rejected(self):
        for index, evidence in enumerate([[], [{"quote": "flag", "start": 0, "end": 4}],
                                          [{"quote": "invented", "start": 6, "end": 10}]]):
            with self.subTest(index=index):
                output = primary("ambiguous")
                output["subject_attribution"]["evidence"] = evidence
                result, actual = self.call("validate", f"evidence-{index}.json", output)
                self.assertEqual(result.returncode, 1)
                self.assertIsNone(actual)

    def test_old_output_without_attribution_is_rejected(self):
        output = primary(candidate=True)
        del output["subject_attribution"]
        result, actual = self.call("validate", "old.json", output)
        self.assertEqual(result.returncode, 1)
        self.assertIsNone(actual)

    def test_existing_response_guards_and_exclusive_create_are_retained(self):
        for index, change in enumerate([{"subject": "other"}, {"source_date": "2000-01-02"},
                                        {"value_span": {"quote": "value", "start": 1, "end": 6}}]):
            with self.subTest(index=index):
                output = primary(candidate=True)
                output["role"]["candidates"][0].update(copy.deepcopy(change))
                result, actual = self.call("validate", f"bad-{index}.json", output)
                self.assertEqual(result.returncode, 1)
                self.assertIsNone(actual)
        result, before = self.call("validate-pair", "once.json", primary(), team())
        self.assertEqual(result.returncode, 0)
        result, after = self.call("validate-pair", "once.json", primary("ambiguous"), team("ambiguous"))
        self.assertEqual(result.returncode, 1)
        self.assertEqual(before, after)


if __name__ == "__main__":
    unittest.main()
