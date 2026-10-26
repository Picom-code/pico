def paginate(items, page, per_page):
    start = (page - 1) * per_page
    return items[start:start + per_page] if start >= 0 else []


def page_count(n_items, per_page):
    return -(-n_items // per_page)
