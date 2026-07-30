import unittest

from iot import _location_event


class LocationEventTests(unittest.TestCase):
    def test_parses_aws_sidewalk_geojson(self) -> None:
        message = {
            "coordinates": [-71.0589, 42.3601, 14.5],
            "WirelessDeviceId": "device-id",
            "type": "Point",
            "properties": {
                "measurementType": "BLE",
                "horizontalAccuracy": 120,
                "verticalAccuracy": 20,
                "timestamp": "2026-07-30T18:00:00Z",
            },
        }

        event = _location_event(message, "sidewalk/location")

        self.assertIsNotNone(event)
        assert event is not None
        self.assertEqual(event["type"], "location")
        self.assertEqual(event["wireless_device_id"], "device-id")
        self.assertEqual(event["longitude"], -71.0589)
        self.assertEqual(event["latitude"], 42.3601)
        self.assertEqual(event["altitude"], 14.5)
        self.assertEqual(event["measurement_type"], "BLE")
        self.assertEqual(event["horizontal_accuracy"], 120)

    def test_rejects_non_location_json(self) -> None:
        self.assertIsNone(_location_event({"PayloadData": "dGVzdA=="}, "uplink"))

    def test_rejects_invalid_coordinate_range(self) -> None:
        self.assertIsNone(
            _location_event(
                {
                    "coordinates": [42.3601, -181],
                    "WirelessDeviceId": "device-id",
                    "type": "Point",
                },
                "sidewalk/location",
            )
        )


if __name__ == "__main__":
    unittest.main()
