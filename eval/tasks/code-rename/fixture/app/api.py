from app.users import get_usr, get_usrs_page


def handle(path):
    if path.startswith("/user/"):
        return get_usr(int(path.rsplit("/", 1)[1])) or "404"
    if path.startswith("/users/"):
        return ",".join(get_usrs_page(int(path.rsplit("/", 1)[1])))
    return "404"
