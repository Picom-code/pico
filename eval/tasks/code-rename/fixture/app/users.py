USERS = {1: "ada", 2: "linus", 3: "grace"}


def get_usr(uid):
    return USERS.get(uid)


def get_usrs_page(page, size=2):
    ids = sorted(USERS)[(page - 1) * size: page * size]
    return [get_usr(i) for i in ids]
