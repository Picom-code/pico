def paginate(items, page, per_page):
    """Return the items on 1-indexed `page` with `per_page` items per page.

    paginate([1,2,3,4,5], 1, 2) -> [1, 2]
    paginate([1,2,3,4,5], 3, 2) -> [5]
    Pages past the end return [].
    """
    start = page * per_page
    end = start + per_page + 1
    return items[start:end]


def page_count(n_items, per_page):
    """Number of pages needed for n_items (0 items -> 0 pages)."""
    return n_items // per_page
