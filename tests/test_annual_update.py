from unittest.mock import patch

from geocoding.annual_update import annual_update


def test_annual_update_calls_update_state_for_every_requested_state(tmp_path):
    with patch("geocoding.annual_update.update_state") as mock_update_state, patch(
        "geocoding.annual_update.ingest_address_points"
    ) as mock_ingest_points, patch("geocoding.annual_update.refresh_routing_topology"):
        mock_ingest_points.return_value = 0
        ok = annual_update("unused-dsn", 2025, tmp_path, states=["ME", "NH"])

    assert ok is True
    assert mock_update_state.call_count == 2
    called_states = {call.args[0] for call in mock_update_state.call_args_list}
    assert called_states == {"ME", "NH"}
    mock_ingest_points.assert_called_once_with("unused-dsn")


def test_annual_update_skips_address_points_when_requested(tmp_path):
    with patch("geocoding.annual_update.update_state"), patch(
        "geocoding.annual_update.ingest_address_points"
    ) as mock_ingest_points, patch("geocoding.annual_update.refresh_routing_topology"):
        ok = annual_update("unused-dsn", 2025, tmp_path, states=["ME"], skip_address_points=True)

    assert ok is True
    mock_ingest_points.assert_not_called()


def test_annual_update_skips_address_points_when_maine_not_in_states(tmp_path):
    with patch("geocoding.annual_update.update_state"), patch(
        "geocoding.annual_update.ingest_address_points"
    ) as mock_ingest_points, patch("geocoding.annual_update.refresh_routing_topology"):
        ok = annual_update("unused-dsn", 2025, tmp_path, states=["NH"])

    assert ok is True
    mock_ingest_points.assert_not_called()


def test_annual_update_continues_past_a_failed_state_and_returns_false(tmp_path):
    def fake_update_state(state_abbr, dsn, year, data_dir):
        if state_abbr == "ME":
            raise RuntimeError("network error")

    with patch(
        "geocoding.annual_update.update_state", side_effect=fake_update_state
    ) as mock_update_state, patch(
        "geocoding.annual_update.ingest_address_points"
    ) as mock_ingest_points, patch("geocoding.annual_update.refresh_routing_topology"):
        mock_ingest_points.return_value = 5
        ok = annual_update("unused-dsn", 2025, tmp_path, states=["ME", "NH"])

    assert ok is False
    assert mock_update_state.call_count == 2
    # The ME streets failure shouldn't block the Maine address-point refresh.
    mock_ingest_points.assert_called_once()


def test_annual_update_returns_false_when_address_point_refresh_fails(tmp_path):
    with patch("geocoding.annual_update.update_state"), patch(
        "geocoding.annual_update.ingest_address_points", side_effect=RuntimeError("boom")
    ), patch("geocoding.annual_update.refresh_routing_topology"):
        ok = annual_update("unused-dsn", 2025, tmp_path, states=["ME"])

    assert ok is False


def test_annual_update_refreshes_routing_topology_after_all_states(tmp_path):
    with patch("geocoding.annual_update.update_state"), patch(
        "geocoding.annual_update.ingest_address_points"
    ) as mock_ingest_points, patch(
        "geocoding.annual_update.refresh_routing_topology"
    ) as mock_refresh_topology:
        mock_ingest_points.return_value = 0
        ok = annual_update("unused-dsn", 2025, tmp_path, states=["ME"])

    assert ok is True
    mock_refresh_topology.assert_called_once_with("unused-dsn")


def test_annual_update_returns_false_when_routing_topology_refresh_fails(tmp_path):
    with patch("geocoding.annual_update.update_state"), patch(
        "geocoding.annual_update.ingest_address_points"
    ) as mock_ingest_points, patch(
        "geocoding.annual_update.refresh_routing_topology", side_effect=RuntimeError("boom")
    ):
        mock_ingest_points.return_value = 0
        ok = annual_update("unused-dsn", 2025, tmp_path, states=["ME"])

    assert ok is False
    # A topology-refresh failure shouldn't block the Maine address-point refresh.
    mock_ingest_points.assert_called_once()
