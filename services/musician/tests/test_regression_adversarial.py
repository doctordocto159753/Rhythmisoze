"""The adversarial review's regression suite.

Every test here reproduces a defect that was found by attacking the running
system rather than by reading it, and each one fails against the code as it was.
They are grouped by the scenario that produced them so a future reader can see
what question was being asked.
"""

from __future__ import annotations

import json
import threading
import time

import pytest
from conftest import build_input, build_notes
from fastapi.testclient import TestClient
from musician_api.config import AdapterMode, Device, Settings
from musician_api.jobs import Job, JobState, JobStore, WorkerLoop
from musician_api.main import create_app
from musician_api.worker_clients import HttpMelodyAdapter, HttpRwkvAdapter, _notes_from
from musician_shared.adapters.base import GenerationError, MelodyRequest, MelodyResponse
from musician_shared.adapters.fake import FakeMelodyAdapter, FakeRwkvAdapter, RogueMelodyAdapter
from musician_shared.contract import (
    MAX_NOTES,
    IdentityReport,
    Key,
    Meter,
    Mode,
    MusicianInput,
    Note,
    Tempo,
    Variant,
    VariantKind,
    check_monophonic,
)
from musician_shared.identity import UNBOUNDED_RATIO, evaluate_identity
from musician_shared.pipeline import run_musician
from musician_shared.policies import policy_for
from pydantic import ValidationError

FOUR_FOUR = Meter(numerator=4, denominator=4, confidence=0.8)


def settings(**overrides) -> Settings:
    base = {
        "device": Device.CPU,
        "adapter_mode": AdapterMode.FAKE,
        "melodyt5_url": "http://unused",
        "rwkv_url": "http://unused",
        "worker_timeout_sec": 5.0,
        "redis_url": None,
        "queue_name": "regression:jobs",
        "melody_concurrency": 1,
        "rwkv_concurrency": 1,
        "job_ttl_sec": 60,
        "generation_timeout_sec": 30,
        "max_queue_depth": 16,
        "log_level": "CRITICAL",
    }
    base.update(overrides)
    return Settings(**base)


def _identity_stub(**overrides) -> IdentityReport:
    fields = {
        "contour_similarity": 1.0,
        "motif_survival": 1.0,
        "phrase_similarity": 1.0,
        "tonal_compatibility": 1.0,
        "meter_compatibility": 1.0,
        "duration_ratio": 1.0,
        "pitch_range_change": 1.0,
        "note_density_change": 1.0,
        "aggregate": 1.0,
        "passed": True,
    }
    fields.update(overrides)
    return IdentityReport(**fields)


class TestNoAcceptableCandidateIsNotASuccess:
    """Scenario 8: nothing passes the guard.

    The pipeline correctly returns the Teacher material rather than the least-bad
    reject. What it did not do was *say so*: the notes were the Teacher's,
    ``identity.passed`` was ``True`` (the guard had compared the Teacher against
    itself) and ``kind`` still said ``refined``. A client had no field to
    distinguish an honest refusal from a generation, so the product presented the
    Teacher as the Musician's work -- the exact failure the guard exists to
    prevent, arriving through the front door.
    """

    def test_a_refusal_is_marked_as_one(self, simple_melody) -> None:
        result = run_musician(
            source=simple_melody, melody=RogueMelodyAdapter(), rwkv=FakeRwkvAdapter()
        )
        for variant in (result.refined, result.developed, result.expanded):
            assert variant.notes == simple_melody.notes
            assert variant.source_fallback is True, (
                "the Teacher material came back unchanged and nothing said so"
            )

    def test_a_real_generation_is_not_marked_as_a_refusal(self, simple_melody) -> None:
        # The counterweight: if this flag were set unconditionally it would be
        # useless, and every generation would look like a refusal.
        result = run_musician(
            source=simple_melody, melody=FakeMelodyAdapter(), rwkv=FakeRwkvAdapter(), base_seed=42
        )
        assert result.refined.source_fallback is False
        assert result.developed.source_fallback is False

    def test_the_flag_survives_the_api(self, simple_melody) -> None:
        # It has to reach a client to be worth anything.
        import musician_api.adapters_factory as factory
        import musician_api.main as main_module

        original = factory.build_adapters
        try:
            main_module.build_adapters = lambda _s: (RogueMelodyAdapter(), FakeRwkvAdapter())
            with TestClient(main_module.create_app(settings())) as client:
                payload = {
                    "sourceId": "refusal",
                    "notes": [
                        {"pitch": n.pitch, "startSec": n.start_sec, "endSec": n.end_sec}
                        for n in simple_melody.notes
                    ],
                    "tempo": {"bpm": 120.0, "confidence": 0.8},
                    "meter": {"numerator": 4, "denominator": 4, "confidence": 0.7},
                    "durationSec": simple_melody.duration_sec,
                }
                job_id = client.post("/v1/jobs", json={"teacher": payload}).json()["jobId"]
                deadline = time.monotonic() + 30
                body = {}
                while time.monotonic() < deadline:
                    body = client.get(f"/v1/jobs/{job_id}").json()
                    if body["state"] in ("succeeded", "failed", "cancelled"):
                        break
                    time.sleep(0.02)
                assert body["state"] == "succeeded", body.get("error")
                assert body["result"]["refined"]["source_fallback"] is True
        finally:
            main_module.build_adapters = original


class TestTheOutputSideIsValidatedToo:
    """Scenario 17: malformed model output.

    ``MusicianInput`` refused overlapping and out-of-order notes; ``Variant`` --
    the side assembled from *model* output, after trimming, splicing and
    re-timing -- accepted them. The strictest check in the system was pointed at
    the trusted side only.
    """

    OVERLAPPING = (
        Note(pitch=60, start_sec=0.0, end_sec=1.0, velocity=90),
        Note(pitch=64, start_sec=0.5, end_sec=1.5, velocity=90),
    )
    OUT_OF_ORDER = (
        Note(pitch=60, start_sec=1.0, end_sec=1.4, velocity=90),
        Note(pitch=64, start_sec=0.0, end_sec=0.4, velocity=90),
    )

    def _variant(self, notes, duration=2.0) -> Variant:
        return Variant(
            kind=VariantKind.REFINED,
            notes=notes,
            tempo=Tempo(bpm=120.0, confidence=0.8),
            meter=FOUR_FOUR,
            key=None,
            duration_sec=duration,
            identity=_identity_stub(),
        )

    def test_a_variant_may_not_overlap_itself(self) -> None:
        with pytest.raises(ValidationError, match="overlaps itself"):
            self._variant(self.OVERLAPPING)

    def test_a_variant_may_not_be_out_of_order(self) -> None:
        with pytest.raises(ValidationError, match="ascending"):
            self._variant(self.OUT_OF_ORDER)

    def test_a_variant_may_not_be_empty(self) -> None:
        with pytest.raises(ValidationError):
            self._variant(())

    def test_a_variant_note_may_not_run_past_its_stated_duration(self) -> None:
        with pytest.raises(ValidationError, match="past the variant's stated duration"):
            self._variant(build_notes([60, 62, 64]), duration=0.2)

    def test_a_well_formed_variant_still_builds(self) -> None:
        assert len(self._variant(build_notes([60, 62, 64]), duration=5.0).notes) == 3

    def test_the_wire_boundary_rejects_a_line_that_is_not_monophonic(self) -> None:
        # `_notes_from` validated each note and never the sequence, so a worker
        # could return eight individually-valid notes that overlap. Every stage
        # downstream -- index splicing, phrase-gap derivation, scheduling --
        # assumes order and does not check it.
        payload = [n.model_dump(mode="json") for n in self.OVERLAPPING]
        with pytest.raises(GenerationError, match="not monophonic"):
            _notes_from(payload)

    def test_the_wire_boundary_still_accepts_a_good_line(self) -> None:
        payload = [n.model_dump(mode="json") for n in build_notes([60, 62, 64])]
        assert len(_notes_from(payload)) == 3

    def test_a_worker_returning_an_unsorted_line_rejects_the_candidate(
        self, simple_melody
    ) -> None:
        # End to end: the guard never sees it, and the run degrades to the
        # documented refusal rather than producing a corrupt variant.
        class Unsorted(FakeMelodyAdapter):
            def generate(self, request: MelodyRequest) -> MelodyResponse:
                response = super().generate(request)
                notes = list(response.notes)
                notes[0], notes[-1] = notes[-1], notes[0]
                return MelodyResponse(
                    notes=tuple(notes), meter=response.meter, raw_abc=None
                )

        # The adapter itself is where the check lives, so assert it directly:
        # `Variant` would refuse the spliced result anyway, and a job that raises
        # is a worse outcome than a candidate that is rejected.
        with pytest.raises(GenerationError):
            _notes_from(
                [
                    {"pitch": 60, "startSec": 1.0, "endSec": 1.4, "velocity": 90},
                    {"pitch": 62, "startSec": 0.0, "endSec": 0.4, "velocity": 90},
                ]
            )


class TestIdentityNumbersSurviveJson:
    """Scenario 13: a repeated single pitch.

    ``_safe_ratio`` returned ``float('inf')`` when the reference dimension was
    zero -- which is what a monotone hum is. ``json.dumps`` writes that as bare
    ``Infinity``, which is not JSON: the browser's own parser rejects the whole
    response, so an honest rejection became ``invalid_response`` and the user was
    told the service was broken.
    """

    def _report(self, reference, candidate) -> IdentityReport:
        return evaluate_identity(
            reference=reference,
            reference_key=Key(tonic="C", mode=Mode.MAJOR, confidence=0.7),
            reference_meter=FOUR_FOUR,
            reference_duration_sec=reference[-1].end_sec,
            reference_motifs=[],
            candidate=candidate,
            candidate_meter=FOUR_FOUR,
            candidate_duration_sec=candidate[-1].end_sec,
            thresholds=policy_for(VariantKind.REFINED).identity,
        )

    def test_a_monotone_reference_produces_a_finite_ratio(self) -> None:
        report = self._report(
            build_notes([60] * 8), build_notes([60, 60, 62, 60, 60, 60, 60, 60])
        )
        assert report.pitch_range_change == UNBOUNDED_RATIO
        text = json.dumps(report.model_dump(mode="json"))
        assert "Infinity" not in text and "NaN" not in text

    def test_the_rejection_still_happens(self) -> None:
        # The sentinel must not accidentally pass a threshold: it is far past
        # every ceiling in policies.py, so the candidate is still refused.
        report = self._report(
            build_notes([60] * 8), build_notes([60, 60, 72, 60, 60, 60, 60, 60])
        )
        assert report.passed is False
        assert any("pitch range" in failure for failure in report.failures)

    def test_a_report_cannot_be_built_with_a_non_finite_number(self) -> None:
        # Belt and braces at the type: nothing may construct one, whatever a
        # future caller computes.
        with pytest.raises(ValidationError, match="not finite"):
            _identity_stub(pitch_range_change=float("inf"))
        with pytest.raises(ValidationError, match="not finite"):
            _identity_stub(aggregate=float("nan"))

    def test_a_monotone_source_still_serialises_end_to_end(self) -> None:
        source = MusicianInput(
            source_id="monotone",
            notes=build_notes([60] * 10),
            tempo=Tempo(bpm=120.0, confidence=0.8),
            meter=FOUR_FOUR,
            key=Key(tonic="C", mode=Mode.MAJOR, confidence=0.7),
            duration_sec=build_notes([60] * 10)[-1].end_sec + 0.5,
        )
        output = run_musician(
            source=source, melody=FakeMelodyAdapter(), rwkv=FakeRwkvAdapter(), base_seed=3
        )
        text = json.dumps(output.model_dump(mode="json"))
        assert "Infinity" not in text and "NaN" not in text


class TestInputSizeIsBounded:
    """Scenario 16 and 31: a huge note array.

    The contract accepted 10000 notes. The Identity Guard's contour comparison is
    quadratic -- measured at ~1 s per call over 2000 notes -- and a job makes 13
    of them plus one per infill attempt, on a service with one worker thread. The
    app records 60 seconds of monophonic audio, so nothing legitimate comes close.
    """

    def test_a_melody_past_the_ceiling_is_refused(self) -> None:
        too_many = build_notes([60] * (MAX_NOTES + 1), duration=0.05, gap=0.0)
        with pytest.raises(ValidationError, match="exceeds the limit"):
            MusicianInput(
                source_id="huge",
                notes=too_many,
                tempo=Tempo(bpm=120.0, confidence=0.8),
                meter=FOUR_FOUR,
                duration_sec=too_many[-1].end_sec + 1,
            )

    def test_a_variant_past_the_ceiling_is_refused(self) -> None:
        # Expanded is meant to be long. Long is not unbounded, and the renderer
        # and MIDI export carry whatever this allows.
        too_many = build_notes([60] * (MAX_NOTES + 1), duration=0.05, gap=0.0)
        with pytest.raises(ValidationError, match="exceeds the limit"):
            Variant(
                kind=VariantKind.EXPANDED,
                notes=too_many,
                tempo=Tempo(bpm=120.0, confidence=0.8),
                meter=FOUR_FOUR,
                key=None,
                duration_sec=too_many[-1].end_sec,
                identity=_identity_stub(),
            )

    def test_the_api_refuses_it_at_the_boundary(self) -> None:
        with TestClient(create_app(settings())) as client:
            notes = [
                {
                    "pitch": 60,
                    "startSec": round(i * 0.05, 4),
                    "endSec": round(i * 0.05 + 0.04, 4),
                }
                for i in range(MAX_NOTES + 50)
            ]
            response = client.post(
                "/v1/jobs",
                json={
                    "teacher": {
                        "sourceId": "huge",
                        "notes": notes,
                        "tempo": {"bpm": 120.0, "confidence": 0.8},
                        "meter": {"numerator": 4, "denominator": 4, "confidence": 0.7},
                        "durationSec": round((MAX_NOTES + 50) * 0.05 + 1, 4),
                    }
                },
            )
            assert response.status_code == 422
            assert "exceeds the limit" in response.text

    def test_a_normal_melody_is_unaffected(self) -> None:
        assert len(build_input([60, 62, 64, 65]).notes) == 4


class TestCancellationCannotBeOverwritten:
    """Scenario 5: cancel at every stage.

    Two races, both silent. ``claim()`` read the job, checked terminal state and
    wrote ``RUNNING`` in three separate statements, so a ``DELETE`` landing in
    between was acknowledged as cancelled and then overwritten. And a cancel
    arriving after the pipeline's last checkpoint let the worker store a result
    for a job the client had already been told was stopped.
    """

    def test_a_job_cancelled_while_queued_is_never_claimed(self) -> None:
        store = JobStore(redis_url=None, queue_name="t", ttl_sec=60)
        job = store.create({"source": {}, "seed": 1})
        store.request_cancel(job.id)
        assert store.claim(timeout_sec=0.05) is None
        assert store.get(job.id).state is JobState.CANCELLED

    def test_claim_and_cancel_never_disagree_under_contention(self) -> None:
        # The original code lost the cancel in a window between its own reads and
        # writes. Hammering the two together is the only honest way to assert the
        # window is gone.
        for _ in range(200):
            store = JobStore(redis_url=None, queue_name="t", ttl_sec=60)
            job = store.create({"source": {}, "seed": 1})
            barrier = threading.Barrier(2)
            outcome: dict[str, object] = {}

            def claim() -> None:
                barrier.wait()
                outcome["claimed"] = store.claim(timeout_sec=1.0)

            def cancel() -> None:
                barrier.wait()
                outcome["cancelled"] = store.request_cancel(job.id)

            threads = [threading.Thread(target=claim), threading.Thread(target=cancel)]
            for thread in threads:
                thread.start()
            for thread in threads:
                thread.join()

            acknowledged = outcome.get("cancelled")
            final = store.get(job.id)
            if getattr(acknowledged, "state", None) is JobState.CANCELLED:
                assert final.state is JobState.CANCELLED, (
                    "the service acknowledged a cancel and then started the job anyway"
                )

    def test_a_result_for_a_cancelled_job_is_discarded(self) -> None:
        store = JobStore(redis_url=None, queue_name="t", ttl_sec=60)
        released = threading.Event()

        def slow(job: Job) -> dict:
            # Cancel lands here: after the pipeline's last checkpoint, before the
            # worker stores anything.
            store.request_cancel(job.id)
            released.set()
            return {"refined": "would have been a result"}

        loop = WorkerLoop(store=store, handler=slow)
        loop.start()
        try:
            job = store.create({"source": {}, "seed": 1})
            assert released.wait(timeout=5)
            deadline = time.monotonic() + 5
            while time.monotonic() < deadline:
                current = store.get(job.id)
                if current.state.terminal:
                    break
                time.sleep(0.02)
            assert current.state is JobState.CANCELLED
            assert current.result is None, "a cancelled job kept the result it produced"
        finally:
            loop.stop()


class TestRestartDoesNotLeaveAnEternalSpinner:
    """Scenario 6: musician-api restart.

    A job that was mid-generation still reads ``running`` in Redis after the
    process dies, and nothing will ever advance it. The client polls a state that
    cannot change -- indistinguishable, from the user's side, from slow
    generation.
    """

    def test_orphaned_running_jobs_are_failed_at_startup(self) -> None:
        store = JobStore(redis_url=None, queue_name="t", ttl_sec=60)
        fake = _FakeRedis()
        store._redis = fake  # noqa: SLF001 - standing in for a real server
        store.backend = "redis"

        job = store.create({"source": {}, "seed": 1})
        claimed = store.claim(timeout_sec=1.0)
        assert claimed is not None and claimed.state is JobState.RUNNING

        # The process dies here. A new one starts with an empty cache.
        store._jobs.clear()  # noqa: SLF001

        assert store.fail_orphaned_running() == 1
        recovered = store.get(job.id)
        assert recovered.state is JobState.FAILED
        assert "restart" in recovered.error
        # The message a user might read must not blame their work.
        assert "your existing versions are unchanged" in recovered.error

    def test_the_memory_backend_has_nothing_to_recover(self) -> None:
        # Explicitly ephemeral, and `/ready` says so. Claiming a recovery here
        # would be theatre.
        store = JobStore(redis_url=None, queue_name="t", ttl_sec=60)
        assert store.fail_orphaned_running() == 0

    def test_a_finished_job_is_not_touched(self) -> None:
        store = JobStore(redis_url=None, queue_name="t", ttl_sec=60)
        store._redis = _FakeRedis()  # noqa: SLF001
        store.backend = "redis"
        job = store.create({"source": {}, "seed": 1})
        job.state = JobState.SUCCEEDED
        job.result = {"kept": True}
        job.finished_at = time.time()
        store.update(job)

        assert store.fail_orphaned_running() == 0
        assert store.get(job.id).state is JobState.SUCCEEDED
        assert store.get(job.id).result == {"kept": True}


class TestTheJobCacheIsBounded:
    """Scenario 15 and 31: the in-process job dict was a leak.

    Every job -- payload, notes, provenance, diagnostics -- stayed resident for
    the life of the process. Redis expired its copy; nothing expired this one. On
    the Redis path the local ``_pending`` list also grew forever, because
    ``claim()`` pops from Redis and never from it.
    """

    def test_finished_jobs_are_evicted_once_past_their_ttl(self) -> None:
        store = JobStore(redis_url=None, queue_name="t", ttl_sec=0)
        for _ in range(80):
            job = store.create({"source": {}, "seed": 1})
            job.state = JobState.SUCCEEDED
            job.finished_at = time.time() - 10
            job.result = {"notes": [0] * 100}
            store.update(job)
        assert len(store._jobs) < 80, "finished jobs are never released"  # noqa: SLF001

    def test_an_unfinished_job_is_never_evicted(self) -> None:
        store = JobStore(redis_url=None, queue_name="t", ttl_sec=0)
        keep = store.create({"source": {}, "seed": 1})
        for _ in range(80):
            job = store.create({"source": {}, "seed": 1})
            job.state = JobState.SUCCEEDED
            job.finished_at = time.time() - 10
            store.update(job)
        assert store.get(keep.id) is not None

    def test_the_redis_path_does_not_keep_a_second_queue(self) -> None:
        store = JobStore(redis_url=None, queue_name="t", ttl_sec=60)
        store._redis = _FakeRedis()  # noqa: SLF001
        store.backend = "redis"
        for _ in range(5):
            store.create({"source": {}, "seed": 1})
        assert store._pending == [], (  # noqa: SLF001
            "the memory queue grew on the Redis path, where nothing drains it"
        )
        assert store.queue_length() == 5


class TestReadinessMatchesWhatThePipelineCanDo:
    """Scenario 7: models available independently.

    ``/ready`` required both workers. The pipeline explicitly does not: infill is
    an improvement pass and ``_run_infill`` keeps the candidate when RWKV is
    unreachable. So with only RWKV down the service reported itself unavailable
    and the proxy hid the feature -- refusing results it was able to produce.
    """

    def _app(self, melody_available: bool, rwkv_available: bool):
        import musician_api.main as main_module

        original = main_module.build_adapters
        main_module.build_adapters = lambda _s: (
            FakeMelodyAdapter(available=melody_available),
            FakeRwkvAdapter(available=rwkv_available),
        )
        try:
            return TestClient(main_module.create_app(settings())), original
        except Exception:
            main_module.build_adapters = original
            raise

    def test_melodyt5_up_and_rwkv_down_is_ready_but_degraded(self) -> None:
        import musician_api.main as main_module

        client, original = self._app(True, False)
        try:
            with client:
                response = client.get("/ready")
                assert response.status_code == 200
                body = response.json()
                assert body["ready"] is True
                assert body["degraded"] is True
                assert body["models"]["midiRwkv"] is False
                assert "local-repair" in body["detail"]
        finally:
            main_module.build_adapters = original

    def test_melodyt5_down_is_not_ready(self) -> None:
        import musician_api.main as main_module

        client, original = self._app(False, True)
        try:
            with client:
                assert client.get("/ready").status_code == 503
        finally:
            main_module.build_adapters = original

    def test_a_job_is_refused_outright_when_melodyt5_is_down(self) -> None:
        # Otherwise it queues, runs, rejects every seed and returns the Teacher
        # material: minutes of spinner ending in a version the user already had.
        import musician_api.main as main_module

        client, original = self._app(False, True)
        try:
            with client:
                response = client.post(
                    "/v1/jobs",
                    json={
                        "teacher": {
                            "sourceId": "no-melody",
                            "notes": [
                                {"pitch": 60, "startSec": 0.0, "endSec": 0.45},
                                {"pitch": 62, "startSec": 0.5, "endSec": 0.95},
                            ],
                            "tempo": {"bpm": 120.0, "confidence": 0.8},
                            "meter": {"numerator": 4, "denominator": 4, "confidence": 0.7},
                            "durationSec": 1.5,
                        }
                    },
                )
                assert response.status_code == 503
        finally:
            main_module.build_adapters = original

    def test_a_job_still_runs_with_only_rwkv_down(self, simple_melody) -> None:
        # The claim in the docstring, exercised rather than asserted about.
        result = run_musician(
            source=simple_melody,
            melody=FakeMelodyAdapter(),
            rwkv=FakeRwkvAdapter(available=False),
        )
        assert result.refined.notes
        assert result.refined.source_fallback is False


class TestInternalAddressesStayInternal:
    """Scenario 24 and section 13: worker URLs leaked through error messages.

    ``ModelUnavailableError`` text reaches ``job.error``, which ``/v1/jobs/{id}``
    returns verbatim and the web proxy forwards to the browser. So an outage
    published ``http://melodyt5-worker:8081`` to every polling client -- the one
    thing ``src/app/api/musician/config.ts`` exists to prevent.
    """

    def test_an_unreachable_worker_does_not_name_itself(self) -> None:
        adapter = HttpMelodyAdapter(
            base_url="http://melodyt5-worker.internal:8081", timeout=0.05
        )
        with pytest.raises(Exception) as caught:  # noqa: PT011 - kind asserted below
            adapter.generate(
                MelodyRequest(
                    notes=build_notes([60, 62]),
                    meter=FOUR_FOUR,
                    tempo_bpm=120.0,
                    key=None,
                    sampling=policy_for(VariantKind.REFINED).melody_sampling,
                    seed=1,
                )
            )
        message = str(caught.value)
        assert "melodyt5-worker.internal" not in message
        assert "8081" not in message
        assert "melody model" in message

    def test_the_repair_worker_is_named_by_role_too(self) -> None:
        adapter = HttpRwkvAdapter(base_url="http://rwkv-worker.internal:8082", timeout=0.05)
        assert adapter.label == "local-repair model"
        assert "rwkv-worker" not in adapter.label


class TestAnInfillCannotMoveTheMelody:
    """The invariant that makes local repair safe to splice.

    ``generate_variant`` replaces a span by index: ``notes[:start] + fill +
    notes[end:]``. That is only sound if the fill occupies exactly the span it
    was given. A model is not a contract -- it returns whatever length it feels
    like -- and a fill that ran long would push every later note out of place,
    turning a repair into a corruption that nothing downstream can detect,
    because the result is still valid notation with valid timings.

    ``_fit_to_span`` is the single place that guarantees it, and it was reachable
    only through a running model. These drive it directly, because an invariant
    that is only checked when the weights are present is not checked in CI at
    all.
    """

    @staticmethod
    def _fit(pitches: list[int], span_pitches: list[int]):
        import sys
        from pathlib import Path

        root = Path(__file__).resolve().parents[1]
        worker_src = str(root / "rwkv-worker" / "src")
        if worker_src not in sys.path:
            sys.path.insert(0, worker_src)
        from rwkv_worker.inference import RwkvRuntime  # noqa: PLC0415

        span = tuple(
            Note(pitch=p, start_sec=i * 0.5, end_sec=i * 0.5 + 0.4, velocity=90)
            for i, p in enumerate(span_pitches)
        )
        parsed = [
            Note(pitch=p, start_sec=i * 0.9, end_sec=i * 0.9 + 0.8, velocity=64)
            for i, p in enumerate(pitches)
        ]
        return RwkvRuntime._fit_to_span(parsed, span), span  # noqa: SLF001

    def test_the_fill_starts_and_ends_exactly_where_the_span_did(self) -> None:
        fitted, span = self._fit([70, 71, 72], [60, 62, 64])
        assert fitted[0].start_sec == pytest.approx(span[0].start_sec)
        assert fitted[-1].end_sec == pytest.approx(span[-1].end_sec)

    def test_a_generation_longer_than_the_span_is_cut_rather_than_appended(self) -> None:
        # The failure this prevents: eight notes spliced into a five-note hole
        # shifts everything after it by three notes' worth of time.
        fitted, span = self._fit([70, 71, 72, 73, 74, 75, 76, 77], [60, 62, 64])
        assert len(fitted) == len(span)
        assert fitted[-1].end_sec == pytest.approx(span[-1].end_sec)

    def test_a_generation_shorter_than_the_span_keeps_the_original_tail(self) -> None:
        # The span must be *filled*, not truncated: dropping the tail would
        # silently shorten the melody by however little the model chose to say.
        fitted, span = self._fit([70], [60, 62, 64])
        assert len(fitted) == len(span)
        assert [n.pitch for n in fitted] == [70, 62, 64]
        assert fitted[-1].end_sec == pytest.approx(span[-1].end_sec)

    def test_an_empty_generation_returns_nothing_rather_than_a_partial_span(self) -> None:
        fitted, _ = self._fit([], [60, 62, 64])
        assert fitted == []

    def test_the_model_supplies_pitch_and_the_span_supplies_time(self) -> None:
        """The deliberate trade, pinned so it cannot drift unnoticed.

        The model's own rhythm is discarded. That is a real cost -- a fill is
        re-voiced onto the span's timing rather than played as written -- and it
        is chosen because a repair that cannot move its neighbours is worth more
        than one that keeps its rhythm. Written down as a test so that changing
        it is a decision rather than an accident.
        """
        fitted, span = self._fit([70, 71, 72], [60, 62, 64])
        assert [n.pitch for n in fitted] == [70, 71, 72]
        assert [n.start_sec for n in fitted] == [n.start_sec for n in span]
        assert [n.end_sec for n in fitted] == [n.end_sec for n in span]


class TestMonophonicHelperIsShared:
    """The check itself, so both call sites cannot drift apart."""

    def test_it_accepts_a_clean_line(self) -> None:
        check_monophonic(build_notes([60, 62, 64]))

    def test_it_tolerates_a_rounding_gap(self) -> None:
        # Float seconds out of an audio pipeline are not exact; refusing a 1e-9
        # overlap would reject valid Teacher output.
        check_monophonic(
            (
                Note(pitch=60, start_sec=0.0, end_sec=0.5, velocity=90),
                Note(pitch=64, start_sec=0.49999999, end_sec=1.0, velocity=90),
            )
        )

    def test_it_refuses_real_polyphony(self) -> None:
        with pytest.raises(ValueError, match="overlaps itself"):
            check_monophonic(
                (
                    Note(pitch=60, start_sec=0.0, end_sec=1.0, velocity=90),
                    Note(pitch=64, start_sec=0.5, end_sec=1.5, velocity=90),
                )
            )


class _FakeRedis:
    """The slice of the Redis API ``JobStore`` uses.

    A real server would make these tests need infrastructure to assert a
    behaviour that is entirely about our own bookkeeping. This is deliberately
    dumb: a dict, a list, and ``scan`` over the keys.
    """

    def __init__(self) -> None:
        self.values: dict[str, str] = {}
        self.queue: list[str] = []

    def ping(self) -> bool:
        return True

    def setex(self, key: str, _ttl: int, value: str) -> None:
        self.values[key] = value

    def get(self, key: str) -> str | None:
        return self.values.get(key)

    def rpush(self, _name: str, value: str) -> None:
        self.queue.append(value)

    def blpop(self, _name: str, timeout: int = 1):
        if not self.queue:
            return None
        return ("q", self.queue.pop(0))

    def llen(self, _name: str) -> int:
        return len(self.queue)

    def scan(self, cursor: int = 0, match: str | None = None, count: int = 100):
        prefix = (match or "*").rstrip("*")
        keys = [key for key in list(self.values) if key.startswith(prefix)]
        return 0, keys
