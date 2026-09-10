"""Permission boundaries and recovery from partial cloud provisioning."""
import json
import tempfile
import unittest
from contextlib import ExitStack
from pathlib import Path
from unittest.mock import patch

from test_provisioning_endpoints import _valid_certificate_json, app_module
from storage import DemoStore
import provisioning


class AutomaticProvisioningTests(unittest.TestCase):
    def setUp(self):
        self.context = ExitStack()
        self.addCleanup(self.context.close)
        self.tmp = self.context.enter_context(tempfile.TemporaryDirectory())
        self.store = DemoStore(str(Path(self.tmp) / 'test.db'))
        self.store.init_db()
        self.context.enter_context(patch.object(app_module, 'store', self.store))
        self.context.enter_context(patch.object(app_module, '_sync_topics'))
        for name, value in dict(SIDEWALK_DEVICE_PROFILE_ID='profile', SIDEWALK_DESTINATION_NAME='dest',
                                AWS_IOT_UPLINK_TOPIC='topic', MEMFAULT_ENABLED=True,
                                MEMFAULT_ORG_AUTH_TOKEN='fake', MEMFAULT_ORG_SLUG='test',
                                MEMFAULT_PROJECT_SLUG='test', MEMFAULT_HARDWARE_VERSION='devkit').items():
            self.context.enter_context(patch.object(app_module.DemoConfig, name, value))
        self.owner = self.store.create_customer(email='owner@test.com', password='p', display_name='Owner', notes='', can_provision=True)
        self.other = self.store.create_customer(email='other@test.com', password='p', display_name='Other', notes='', can_provision=True)
        cert = provisioning.validate_certificate_json(_valid_certificate_json())
        self.artifacts = (provisioning.wireless_device_json_from_certificate_json(cert),
                          provisioning.device_profile_json_from_certificate_json(cert), cert)
        self.create = self.context.enter_context(patch.object(app_module.cloud_service, 'create_wireless_device', return_value={'id':'aws-device'}))
        self.refresh = self.context.enter_context(patch.object(app_module.cloud_service, 'refresh_device_artifacts', return_value=self.artifacts))
        self.memfault = self.context.enter_context(patch.object(app_module.memfault_service, 'ensure_device_for', return_value={'ok':True, 'deviceSerial': cert['metadata']['smsn']}))
        self.client = self.client_for(self.owner)
        self.body = {'connectionKey':'bluetooth-device-id', 'unprovisioned':True}

    def client_for(self, user):
        client = app_module.app.test_client()
        with client.session_transaction() as session:
            session['user_id'] = user['id']
        return client

    def post(self, client=None, body=None):
        return (client or self.client).post('/api/provisioning/automatic', json=body or self.body)

    def test_customer_without_existing_devices_can_create_and_retry(self):
        self.assertEqual(self.store.list_devices_for_user(self.owner), [])
        first = self.post()
        self.assertEqual(first.status_code, 200, first.json)
        second = self.post()
        self.assertEqual(second.json['device']['id'], first.json['device']['id'])
        self.create.assert_called_once()
        self.assertEqual(len(self.store.list_devices_for_user(self.owner)), 1)
        self.assertEqual(self.store.list_devices_for_user(self.other), [])
        self.assertNotIn('commands', first.json)
        self.assertNotIn('devicePrivKey', json.dumps(first.json))
        script = self.client.get(f"/api/devices/{first.json['device']['id']}/provisioning-script")
        self.assertEqual(script.status_code, 200)
        self.assertGreater(script.json['valueCount'], 0)

    def test_permission_revocation_blocks_all_cloud_calls(self):
        self.store.update_customer_permissions(self.owner['id'], can_provision=False)
        self.assertEqual(self.post().status_code, 403)
        self.create.assert_not_called()
        self.memfault.assert_not_called()

    def test_another_customer_cannot_reuse_reservation_or_credentials(self):
        first = self.post()
        other = self.client_for(self.other)
        self.assertEqual(self.post(other).status_code, 403)
        self.assertEqual(other.get(f"/api/devices/{first.json['device']['id']}/provisioning-script").status_code, 404)
        self.create.assert_called_once()

    def test_memfault_failure_reuses_saved_aws_device(self):
        self.memfault.side_effect = [{'ok':False}, {'ok':True}]
        self.assertEqual(self.post().status_code, 502)
        self.assertEqual(self.post().status_code, 200)
        self.create.assert_called_once()
        self.assertEqual(self.memfault.call_count, 2)

    def test_artifact_failure_preserves_created_device(self):
        self.refresh.side_effect = [RuntimeError('AWS unavailable'), self.artifacts]
        self.assertEqual(self.post().status_code, 502)
        self.assertEqual(self.post().status_code, 200)
        self.create.assert_called_once()

    def test_uncertain_aws_response_reuses_identical_token_and_parameters(self):
        self.create.side_effect = [TimeoutError('response lost'), {'id':'aws-device'}]
        self.assertEqual(self.post().status_code, 502)
        self.assertEqual(self.post().status_code, 200)
        self.assertEqual(self.create.call_args_list[0], self.create.call_args_list[1])
        self.assertTrue(self.create.call_args.kwargs['client_request_token'])

    def test_explicit_blank_status_and_json_required(self):
        self.assertEqual(self.post(body={'connectionKey':'x', 'unprovisioned':False}).status_code, 400)
        self.assertEqual(self.client.post('/api/provisioning/automatic', data=self.body).status_code, 400)
        self.create.assert_not_called()

    def test_anonymous_cannot_create(self):
        self.assertEqual(self.post(app_module.app.test_client()).status_code, 302)
        self.create.assert_not_called()

    def test_empty_account_dashboard_has_automatic_connect(self):
        page = self.client.get('/').get_data(as_text=True)
        self.assertIn('id="prov-automatic-connect"', page)
        self.store.update_customer_permissions(self.owner['id'], can_provision=False)
        page = self.client.get('/').get_data(as_text=True)
        self.assertNotIn('id="prov-automatic-connect"', page)
