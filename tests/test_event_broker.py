import unittest

from iot import EventBroker


class EventBrokerTests(unittest.TestCase):
    def test_stream_cursor_only_replays_newer_events(self) -> None:
        broker = EventBroker(backlog_size=4)
        for value in range(4):
            broker.publish({"type": "test", "value": value})

        listener, history = broker.open_stream(after_event_id=2)
        self.addCleanup(broker.close_stream, listener)

        self.assertEqual([event["_event_id"] for event in history], [3, 4])
        self.assertEqual([event["value"] for event in history], [2, 3])

        broker.publish({"type": "test", "value": 4})
        live_event = listener.get_nowait()
        self.assertEqual(live_event["_event_id"], 5)
        self.assertEqual(live_event["value"], 4)

    def test_backlog_remains_bounded(self) -> None:
        broker = EventBroker(backlog_size=2)
        for value in range(5):
            broker.publish({"type": "test", "value": value})

        listener, history = broker.open_stream()
        self.addCleanup(broker.close_stream, listener)

        self.assertEqual([event["value"] for event in history], [3, 4])

    def test_cursor_ahead_of_server_replays_after_restart(self) -> None:
        broker = EventBroker(backlog_size=2)
        broker.publish({"type": "test", "value": 1})

        listener, history = broker.open_stream(after_event_id=100)
        self.addCleanup(broker.close_stream, listener)

        self.assertEqual([event["value"] for event in history], [1])

    def test_publish_fans_out_to_many_viewers(self) -> None:
        broker = EventBroker(backlog_size=4)
        listeners = [broker.open_stream()[0] for _ in range(50)]
        for listener in listeners:
            self.addCleanup(broker.close_stream, listener)

        broker.publish({"type": "test", "value": 7})

        self.assertEqual(
            [listener.get_nowait()["value"] for listener in listeners],
            [7] * len(listeners),
        )


if __name__ == "__main__":
    unittest.main()
