import hashlib
import struct
import unittest
from build_patch import ASSETS, patch_bytes


class PatchTests(unittest.TestCase):
    def setUp(self):
        self.data = b"prefix" + struct.pack("<i", 3) + b"suffix"
        self.sha = hashlib.sha256(self.data).hexdigest()

    def test_changes_only_carry_limit_preserving_source(self):
        result = patch_bytes(self.data, self.sha, 6, struct.pack("<i", 3), struct.pack("<i", 7))
        self.assertEqual(result, b"prefix" + struct.pack("<i", 7) + b"suffix")
        self.assertEqual(self.data[6:10], struct.pack("<i", 3))
        self.assertEqual(len(result), len(self.data))

    def test_rejects_other_game_build_before_using_offset(self):
        with self.assertRaisesRegex(ValueError, "Unsupported"):
            patch_bytes(self.data + b"x", self.sha, 6, b"\x03", b"\x07")

    def test_rejects_wrong_original_value(self):
        with self.assertRaisesRegex(ValueError, "does not match"):
            patch_bytes(self.data, self.sha, 6, b"\x04", b"\x07")

    def test_rejects_negative_and_out_of_bounds_offsets(self):
        for offset in (-1, len(self.data)):
            with self.subTest(offset=offset), self.assertRaisesRegex(ValueError, "outside"):
                patch_bytes(self.data, self.sha, offset, b"\x03", b"\x07")

    def test_rejects_resizing_and_empty_replacements(self):
        for before, after in ((b"\x03", b"\x07\x00"), (b"", b"")):
            with self.subTest(before=before), self.assertRaisesRegex(ValueError, "length"):
                patch_bytes(self.data, self.sha, 6, before, after)

    def test_patch_scope_is_one_potion_with_seven_carry_charges(self):
        self.assertEqual(len(ASSETS), 2)
        self.assertEqual(ASSETS[0]["new_value"], 7)
        self.assertEqual(ASSETS[1]["new_value"], "None")
        self.assertEqual(bytes.fromhex(ASSETS[0]["after"]), struct.pack("<i", 7))


if __name__ == "__main__":
    unittest.main()
