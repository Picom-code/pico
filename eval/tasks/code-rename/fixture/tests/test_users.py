import unittest
from app import users
from app.api import handle
from app.admin import describe


class T(unittest.TestCase):
    def test_get(self):
        self.assertEqual(users.get_usr(1), "ada")

    def test_api(self):
        self.assertEqual(handle("/user/2"), "linus")
        self.assertEqual(handle("/users/2"), "grace")

    def test_admin(self):
        self.assertEqual(describe(3), "user 3: grace")
