import json
import os
import stat

import pytest

from conftest import AUTH, MOM
from msg_gw.favorites import MAX_FAVORITES, FavoritesError, FavoritesStore, clean_items


def test_clean_items_dedupes_trims_and_validates():
    assert clean_items(["  Jordan   Lee ", "jordan lee", "+15551234567"]) == ("Jordan Lee", "+15551234567")
    for bad in (["x" * 81], [""], [3], "Jordan", ["bad\x00name"], ["a"] * (MAX_FAVORITES + 1)):
        with pytest.raises(FavoritesError):
            clean_items(bad)


def test_store_persists_with_private_permissions_and_reloads(tmp_path):
    path = str(tmp_path / "favorites.json")
    store = FavoritesStore(("Env Default",), path)
    assert store.get() == ("Env Default",)  # no file yet: env list
    store.set(["Jordan Lee", "Casey Lee"])
    assert json.load(open(path)) == ["Jordan Lee", "Casey Lee"]
    assert stat.S_IMODE(os.stat(path).st_mode) == 0o600
    assert FavoritesStore(("Env Default",), path).get() == ("Jordan Lee", "Casey Lee")  # file wins after restart


def test_store_ignores_corrupt_file(tmp_path):
    path = tmp_path / "favorites.json"
    path.write_text("{not json")
    assert FavoritesStore(("Env Default",), str(path)).get() == ("Env Default",)


def test_put_favorites_round_trip_and_names_apply(make_client, tmp_path):
    client = make_client(G2_FAVORITES_FILE=str(tmp_path / "f.json"))
    resp = client.put("/favorites", headers=AUTH, json={"items": ["Jordan Lee", MOM]})
    assert resp.status_code == 200
    assert [f["name"] for f in resp.json()] == ["Jordan Lee", "Mom"]
    assert [f["name"] for f in client.get("/favorites", headers=AUTH).json()] == ["Jordan Lee", "Mom"]
    assert [f["name"] for f in client.get("/config", headers=AUTH).json()["favorites"]] == ["Jordan Lee", "Mom"]


def test_put_favorites_rejects_bad_input(client):
    assert client.put("/favorites", headers=AUTH, json={"items": "Jordan"}).status_code == 400
    assert client.put("/favorites", headers=AUTH, json={"items": ["x" * 200]}).status_code == 400
    assert client.put("/favorites", headers=AUTH, content=b"nope").status_code == 400
    assert client.put("/favorites", json={"items": []}).status_code == 401


def test_cors_allows_put_preflight(client):
    resp = client.options("/favorites", headers={"Origin": "https://app.example", "Access-Control-Request-Method": "PUT",
                                                  "Access-Control-Request-Headers": "authorization,content-type"})
    assert resp.status_code == 200
    assert "PUT" in resp.headers["access-control-allow-methods"]
