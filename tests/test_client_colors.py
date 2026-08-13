import unittest

from client_colors import normalize_client_color, random_client_color


class ClientColorTests(unittest.TestCase):
    def test_random_colors_are_picker_compatible_and_not_constant(self):
        colors = {random_client_color() for _ in range(30)}
        self.assertGreater(len(colors), 1)
        for color in colors:
            self.assertRegex(color, r'^#[0-9a-f]{6}$')

    def test_valid_colors_are_trimmed_and_normalized(self):
        self.assertEqual(normalize_client_color('  #A1B2C3 '), '#a1b2c3')

    def test_shorthand_and_non_hex_colors_are_rejected(self):
        for color in ('#abc', 'red', '#12345g', '', None):
            with self.subTest(color=color), self.assertRaises(ValueError):
                normalize_client_color(color)


if __name__ == '__main__':
    unittest.main()
