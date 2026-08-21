"""H, I, J, K: cancellation, timeout, restart behaviour, missing models.

These exercise the service as a caller sees it. The interesting cases are the
unhappy ones, because a job queue that only works when nothing goes wrong is a
function call with extra steps.
"""

from __future__ import annotations

import time

import pytest
from fastapi.testclient import TestClient
from musician_api.config import AdapterMode, Device, Settings
from musician_api.jobs import Job, JobState, JobStore, WorkerLoop, _JobCancelled
from musician_api.main import create_app


def settings(**overrides) -> Settings:
    base = {
        "device": Device.CPU,
        "adapter_mode": AdapterMode.FAKE,
        "melodyt5_url": "http://unused",
        "rwkv_url": "http://unused",
        "worker_timeout_sec": 5.0,
        "redis_url": None,
        "queue_name": "test:jobs",
        "melody_concurrency": 1,
        "rwkv_concurrency": 1,
        "job_ttl_sec": 60,
        "generation_timeout_sec": 30,
        "log_level": "CRITICAL",
    }
    base.update(overrides)
    return Settings(**base)


@pytest.fixture
def client():
    with TestClient(create_app(settings())) as test_client:
        yield test_client


def teacher_payload(**overrides) -> dict:
    notes = []
    cursor = 0.0
    for pitch in [60, 62, 64, 65, 67, 65, 64, 62, 60, 62, 64, 60]:
        notes.append(
            {"pitch": pitch, "startSec": round(cursor, 4), "endSec": round(cursor + 0.45, 4)}
        )
        cursor += 0.5
    payload = {
        "sourceId": "api-test",
        "notes": notes,
        "tempo": {"bpm": 120.0, "confidence": 0.8},
        "meter": {"numerator": 4, "denominator": 4, "confidence": 0.7},
        "key": {"tonic": "C", "mode": "major", "confidence": 0.7},
        "durationSec": round(cursor + 0.5, 4),
    }
    payload.update(overrides)
    return payload


def wait_for_terminal(client: TestClient, job_id: str, timeout: float = 20.0) -> dict:
    deadline = time.monotonic() + timeout
    body: dict = {}
    while time.monotonic() < deadline:
        body = client.get(f"/v1/jobs/{job_id}").json()
        if body["state"] in ("succeeded", "failed", "cancelled"):
            return body
        time.sleep(0.02)
    raise AssertionError(f"job {job_id} never reached a terminal state; last was {body}")


class TestHealthAndReadiness:
    def test_health_does_not_consult_the_models(self, client) -> None:
        # A liveness probe that touches a model restarts the container whenever
        # inference is merely slow, which is exactly when restarting is worst.
        assert client.get("/health").json()["status"] == "ok"

    def test_ready_reports_the_queue_backend_honestly(self, client) -> None:
        body = client.get("/ready").json()
        assert body["queue"]["backend"] == "memory"
        # "jobs vanished after a restart" is hard to debug if the service never
        # said it was ephemeral.
        assert body["durable"] is False

    def test_the_service_starts_in_cpu_mode_without_a_gpu(self, client) -> None:
        """AC-01 and AC-13, at the API level."""
        body = client.get("/ready").json()
        assert body["ready"] is True
        assert body["device"] == "cpu"

    def test_models_endpoint_names_exact_revisions(self, client) -> None:
        body = client.get("/v1/models").json()
        assert body["melodyT5"]["revision"] == "fake-melodyt5-v1"
        assert body["midiRwkv"]["revision"] == "fake-midi-rwkv-v1"
        assert body["mode"] == "fake"


class TestJobLifecycle:
    def test_a_job_is_accepted_and_completes(self, client) -> None:
        response = client.post("/v1/jobs", json={"teacher": teacher_payload(), "seed": 11})
        assert response.status_code == 202
        job_id = response.json()["jobId"]

        body = wait_for_terminal(client, job_id)
        assert body["state"] == "succeeded", body.get("error")
        result = body["result"]
        assert result["refined"]["notes"]
        assert result["developed"]["notes"]

    def test_the_result_carries_reproducible_provenance(self, client) -> None:
        """AC-08 through the API."""
        job_id = client.post("/v1/jobs", json={"teacher": teacher_payload(), "seed": 5}).json()[
            "jobId"
        ]
        provenance = wait_for_terminal(client, job_id)["result"]["provenance"]
        assert provenance["seeds"]["base"] == 5
        assert provenance["melody_t5_revision"]
        assert provenance["midi_rwkv_revision"]
        assert provenance["musician_service_version"]
        assert provenance["elapsed_ms"] >= 0

    def test_the_result_does_not_leak_model_internals(self, client) -> None:
        job_id = client.post("/v1/jobs", json={"teacher": teacher_payload()}).json()["jobId"]
        result = wait_for_terminal(client, job_id)["result"]
        serialised = str(result)
        for leak in ("logits", "token_ids", "raw_abc", "Traceback", "state_dict"):
            assert leak not in serialised

    def test_an_unknown_job_is_a_404(self, client) -> None:
        assert client.get("/v1/jobs/does-not-exist").status_code == 404

    def test_cancelling_an_unknown_job_is_a_404(self, client) -> None:
        assert client.delete("/v1/jobs/does-not-exist").status_code == 404


class TestValidationAtTheBoundary:
    def test_a_payload_with_no_meter_is_refused_not_defaulted(self, client) -> None:
        """The 4/4 rule, enforced where a caller can see it."""
        payload = teacher_payload()
        payload.pop("meter")
        response = client.post("/v1/jobs", json={"teacher": payload})
        assert response.status_code == 422
        assert "4/4" in response.json()["detail"]

    def test_a_low_confidence_meter_is_refused(self, client) -> None:
        response = client.post(
            "/v1/jobs",
            json={
                "teacher": teacher_payload(
                    meter={"numerator": 4, "denominator": 4, "confidence": 0.05}
                )
            },
        )
        assert response.status_code == 422

    def test_an_empty_melody_is_refused(self, client) -> None:
        assert client.post("/v1/jobs", json={"teacher": teacher_payload(notes=[])}).status_code == 422

    def test_overlapping_notes_are_refused(self, client) -> None:
        overlapping = [
            {"pitch": 60, "startSec": 0.0, "endSec": 1.0},
            {"pitch": 64, "startSec": 0.5, "endSec": 1.5},
        ]
        assert (
            client.post("/v1/jobs", json={"teacher": teacher_payload(notes=overlapping)}).status_code
            == 422
        )

    def test_no_audio_is_required_anywhere(self, client) -> None:
        """AC-11.

        The whole request is symbolic. If an audio field were ever required,
        this would fail -- which is the point of asserting it rather than
        assuming it.
        """
        response = client.post("/v1/jobs", json={"teacher": teacher_payload()})
        assert response.status_code == 202


class TestCancellation:
    def test_a_pending_job_cancels_immediately(self) -> None:
        """H.

        Cancelled before any worker claimed it, so it goes straight to
        cancelled rather than waiting for one to notice.
        """
        store = JobStore(redis_url=None, queue_name="t", ttl_sec=60)
        job = store.create({"source": {}, "seed": 1})
        cancelled = store.request_cancel(job.id)
        assert cancelled is not None
        assert cancelled.state is JobState.CANCELLED
        assert store.claim(timeout_sec=0.05) is None

    def test_a_running_job_is_flagged_for_cooperative_cancellation(self) -> None:
        # Not killed mid-inference: that would leave a warm worker in an unknown
        # state, which costs more than waiting for the next checkpoint.
        store = JobStore(redis_url=None, queue_name="t", ttl_sec=60)
        job = store.create({"source": {}, "seed": 1})
        claimed = store.claim(timeout_sec=1.0)
        assert claimed is not None and claimed.state is JobState.RUNNING

        store.request_cancel(job.id)
        assert store.is_cancelled(job.id)
        assert store.get(job.id).state is JobState.RUNNING

    def test_cancelling_a_finished_job_leaves_it_finished(self) -> None:
        store = JobStore(redis_url=None, queue_name="t", ttl_sec=60)
        job = store.create({"source": {}, "seed": 1})
        job.state = JobState.SUCCEEDED
        store.update(job)
        assert store.request_cancel(job.id).state is JobState.SUCCEEDED


class TestWorkerLoop:
    def test_a_handler_failure_is_reported_without_a_traceback(self) -> None:
        """K, and the "no internals in responses" rule."""
        store = JobStore(redis_url=None, queue_name="t", ttl_sec=60)

        def explode(job: Job) -> dict:
            raise RuntimeError("weights are missing from /models")

        loop = WorkerLoop(store=store, handler=explode)
        loop.start()
        try:
            job = store.create({"source": {}, "seed": 1})
            deadline = time.monotonic() + 5
            while time.monotonic() < deadline:
                current = store.get(job.id)
                if current.state.terminal:
                    break
                time.sleep(0.02)
            assert current.state is JobState.FAILED
            assert "weights are missing" in current.error
            assert "Traceback" not in current.error
        finally:
            loop.stop()

    def test_a_cancelled_handler_marks_the_job_cancelled(self) -> None:
        store = JobStore(redis_url=None, queue_name="t", ttl_sec=60)

        def bail(job: Job) -> dict:
            raise _JobCancelled(job.id)

        loop = WorkerLoop(store=store, handler=bail)
        loop.start()
        try:
            job = store.create({"source": {}, "seed": 1})
            deadline = time.monotonic() + 5
            while time.monotonic() < deadline:
                current = store.get(job.id)
                if current.state.terminal:
                    break
                time.sleep(0.02)
            assert current.state is JobState.CANCELLED
        finally:
            loop.stop()

    def test_the_loop_survives_a_stop_and_restart(self) -> None:
        """J: restart behaviour.

        The in-memory store is explicitly ephemeral, so what is asserted here is
        that a restarted loop drains work that was queued while it was down --
        not that anything survived the process.
        """
        store = JobStore(redis_url=None, queue_name="t", ttl_sec=60)
        loop = WorkerLoop(store=store, handler=lambda job: {"ok": True})
        loop.start()
        loop.stop()

        job = store.create({"source": {}, "seed": 1})
        assert store.get(job.id).state is JobState.PENDING

        loop.start()
        try:
            deadline = time.monotonic() + 5
            while time.monotonic() < deadline:
                if store.get(job.id).state.terminal:
                    break
                time.sleep(0.02)
            assert store.get(job.id).state is JobState.SUCCEEDED
        finally:
            loop.stop()


class TestMissingModels:
    def test_readiness_goes_red_when_a_model_is_unavailable(self) -> None:
        """K.

        A service that accepts jobs it cannot possibly run turns one clear
        failure into a queue full of confusing ones.
        """
        from musician_shared.adapters.fake import FakeMelodyAdapter, FakeRwkvAdapter

        app = create_app(settings())
        app.state.adapters = (FakeMelodyAdapter(available=False), FakeRwkvAdapter())

        # Rebuild the app with an unavailable model rather than mutating state
        # the closure already captured.
        import musician_api.adapters_factory as factory

        original = factory.build_adapters
        try:
            factory.build_adapters = lambda _s: (
                FakeMelodyAdapter(available=False),
                FakeRwkvAdapter(),
            )
            import musician_api.main as main_module

            main_module.build_adapters = factory.build_adapters
            with TestClient(main_module.create_app(settings())) as unhealthy:
                response = unhealthy.get("/ready")
                assert response.status_code == 503
                assert response.json()["models"]["melodyT5"] is False
        finally:
            factory.build_adapters = original
            import musician_api.main as main_module

            main_module.build_adapters = original


class TestMetrics:
    def test_metrics_report_queue_and_rejection_rate(self, client) -> None:
        job_id = client.post("/v1/jobs", json={"teacher": teacher_payload()}).json()["jobId"]
        wait_for_terminal(client, job_id)
        body = client.get("/metrics").json()
        assert body["jobsEnqueued"] >= 1
        assert body["inferences"] >= 1
        assert 0.0 <= body["candidateRejectionRate"] <= 1.0
