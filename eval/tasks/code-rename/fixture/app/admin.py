from app import users


def describe(uid):
    name = users.get_usr(uid)
    return f"user {uid}: {name}"
