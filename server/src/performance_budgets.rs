//! Deterministic resource gates over real handlers and actual executed SQL.
//! Counters are thread-local and test-only; elapsed time is never a gate.
use super::*;
use axum::http::Request;
use http_body_util::BodyExt;
use rusqlite::StatementStatus;
use std::cell::RefCell;
use tower::ServiceExt;

#[derive(Clone, Copy, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct Work {
    statements: u64,
    fullscan_steps: u64,
    sorts: u64,
    vm_steps: u64,
    representative_lookups: u64,
    entry_visits: u64,
}

thread_local! {
    static OBSERVED: RefCell<Option<Work>> = const { RefCell::new(None) };
}

// Intercept the precise full-library `.values().find(...)` traversal that
// previously ran once per displayed series. Production retains BTreeMap;
// test builds keep identical ordering and lookup behavior while counting each
// visited entry. This is a narrow collection-work counter, not a CPU profiler.
pub(super) struct EntryIndex(BTreeMap<String, Entry>);

impl From<BTreeMap<String, Entry>> for EntryIndex {
    fn from(value: BTreeMap<String, Entry>) -> Self {
        Self(value)
    }
}

impl std::ops::Deref for EntryIndex {
    type Target = BTreeMap<String, Entry>;
    fn deref(&self) -> &Self::Target {
        &self.0
    }
}

impl std::ops::DerefMut for EntryIndex {
    fn deref_mut(&mut self) -> &mut Self::Target {
        &mut self.0
    }
}

impl EntryIndex {
    pub(super) fn values(&self) -> impl DoubleEndedIterator<Item = &Entry> + ExactSizeIterator {
        self.0.values().inspect(|_| {
            OBSERVED.with_borrow_mut(|observed| {
                if let Some(work) = observed {
                    work.entry_visits += 1;
                }
            });
        })
    }
}

pub(super) fn record_statement(statement: &rusqlite::Statement<'_>) {
    OBSERVED.with_borrow_mut(|observed| {
        if let Some(work) = observed {
            work.statements += 1;
            work.fullscan_steps += statement.get_status(StatementStatus::FullscanStep) as u64;
            work.sorts += statement.get_status(StatementStatus::Sort) as u64;
            work.vm_steps += statement.get_status(StatementStatus::VmStep) as u64;
        }
    });
}

pub(super) fn record_representative_lookup() {
    OBSERVED.with_borrow_mut(|observed| {
        if let Some(work) = observed {
            // The page SQL performs one indexed canonical representative
            // lookup per series. Its executed work is included in the same
            // statement counters; startup entry classifications are not used.
            work.representative_lookups += 1;
        }
    });
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Budget {
    max_rows: u64,
    max_wire_bytes: u64,
    max_statements: u64,
    max_fullscan_steps: u64,
    max_sorts: u64,
    max_vm_steps: u64,
    max_representative_lookups: u64,
    max_entry_visits: u64,
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct Observation {
    rows: u64,
    wire_bytes: u64,
    work: Work,
}

impl Budget {
    fn exceeded(&self, value: &Observation) -> Vec<&'static str> {
        [
            ("rows", value.rows, self.max_rows),
            ("wireBytes", value.wire_bytes, self.max_wire_bytes),
            ("statements", value.work.statements, self.max_statements),
            (
                "fullscanSteps",
                value.work.fullscan_steps,
                self.max_fullscan_steps,
            ),
            ("sorts", value.work.sorts, self.max_sorts),
            ("vmSteps", value.work.vm_steps, self.max_vm_steps),
            (
                "representativeLookups",
                value.work.representative_lookups,
                self.max_representative_lookups,
            ),
            (
                "entryVisits",
                value.work.entry_visits,
                self.max_entry_visits,
            ),
        ]
        .into_iter()
        .filter_map(|(name, measured, limit)| (measured > limit).then_some(name))
        .collect()
    }
}

fn manifest() -> serde_json::Value {
    let value: serde_json::Value =
        serde_json::from_str(include_str!("performance-budgets.json")).unwrap();
    assert_eq!(value["schemaVersion"], 1);
    assert_eq!(value["budgetVersion"], 1);
    assert_eq!(value["fixtureId"], "catalog-v1-120000");
    value
}

pub(super) fn resource_limit(name: &str) -> u64 {
    manifest()["resources"][name].as_u64().unwrap()
}

fn request(
    runtime: &tokio::runtime::Runtime,
    app: &Router,
    path: &str,
) -> (Observation, serde_json::Value) {
    OBSERVED.with_borrow_mut(|observed| {
        assert!(observed.replace(Work::default()).is_none());
    });
    let (bytes, value) = runtime.block_on(async {
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .header("host", "127.0.0.1:8787")
                    .uri(path)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        let value: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        (bytes, value)
    });
    let work = OBSERVED.with_borrow_mut(|observed| observed.take().unwrap());
    (
        Observation {
            rows: value["items"].as_array().unwrap().len() as u64,
            wire_bytes: bytes.len() as u64,
            work,
        },
        value,
    )
}

#[test]
fn large_catalog_http_payload_and_query_work_stay_within_explicit_budgets() {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    let _runtime = runtime.enter();
    let (_temp, library) = performance_tests::fixture(100_000, 1000, 20);
    let series_id = library
        .index()
        .entries
        .values()
        .find_map(|entry| entry.media.classification.series_id.as_ref())
        .unwrap()
        .clone();
    let app = router(library.clone());
    let limits = manifest();
    for (name, path, expected_rows, expected_total) in [
        (
            "moviesFirst",
            "/api/catalog?collection=movies&limit=60".into(),
            60,
            100000,
        ),
        (
            "moviesDeep",
            "/api/catalog?collection=movies&offset=90000&limit=60".into(),
            60,
            100000,
        ),
        (
            "movieSearch",
            "/api/catalog?collection=movies&search=Film%20090&limit=60".into(),
            60,
            1000,
        ),
        (
            "episodesPage",
            format!("/api/catalog?collection=tv&series={series_id}&season=1&limit=60"),
            20,
            20,
        ),
        (
            "seriesPage",
            "/api/series?offset=900&limit=60".into(),
            60,
            1000,
        ),
    ] {
        let budget: Budget = serde_json::from_value(limits["limits"][name].clone()).unwrap();
        let (observed, response) = request(&runtime, &app, &path);
        println!(
            "performance-budget {}",
            serde_json::json!({"name":name,"observed":observed})
        );
        assert_eq!(observed.rows, expected_rows);
        assert_eq!(response["total"], expected_total);
        // Missing instrumentation is an error, not a zero-work success.
        assert!(observed.work.statements > 0);
        assert!(observed.work.vm_steps > 0);
        assert_eq!(
            observed.work.representative_lookups,
            if name == "seriesPage" {
                expected_rows
            } else {
                0
            }
        );
        assert!(
            budget.exceeded(&observed).is_empty(),
            "{name}: {:?}; {observed:?}; {budget:?}",
            budget.exceeded(&observed)
        );
    }

    // A direct traversal through the old series implementation's collection
    // API is counted; reintroducing it into a handler cannot report zero work.
    OBSERVED.with_borrow_mut(|observed| {
        assert!(observed.replace(Work::default()).is_none());
    });
    let visited = library
        .index()
        .entries
        .values()
        .filter(|entry| entry.media.classification.series_id.as_ref() == Some(&series_id))
        .count();
    assert_eq!(visited, 20);
    let scan = Observation {
        work: OBSERVED.with_borrow_mut(|observed| observed.take().unwrap()),
        ..Default::default()
    };
    assert_eq!(scan.work.entry_visits, 120000);
    let series_budget: Budget =
        serde_json::from_value(limits["limits"]["seriesPage"].clone()).unwrap();
    assert_eq!(series_budget.exceeded(&scan), ["entryVisits"]);

    // A real query-plan regression must trip the same gate. Removing this
    // index forces a scan/sort fallback even though the returned rows are equal.
    library
        .database
        .lock()
        .unwrap()
        .execute_batch("DROP INDEX media_collection_order")
        .unwrap();
    let budget: Budget = serde_json::from_value(limits["limits"]["moviesFirst"].clone()).unwrap();
    let (regressed, response) = request(&runtime, &app, "/api/catalog?collection=movies&limit=60");
    assert_eq!(response["total"], 100000);
    assert_eq!(regressed.rows, 60);
    let failures = budget.exceeded(&regressed);
    assert!(
        failures.contains(&"fullscanSteps")
            || failures.contains(&"sorts")
            || failures.contains(&"vmSteps"),
        "index-removal probe escaped: {regressed:?}"
    );
    println!(
        "performance-budget regression-probe {}",
        serde_json::json!({"observed":regressed,"exceeded":failures})
    );
}

#[test]
fn every_exceeded_structural_limit_is_detected() {
    let budget = Budget {
        max_rows: 60,
        max_wire_bytes: 24000,
        max_statements: 3,
        max_fullscan_steps: 0,
        max_sorts: 0,
        max_vm_steps: 1000,
        max_representative_lookups: 60,
        max_entry_visits: 0,
    };
    let observation = Observation {
        rows: 61,
        wire_bytes: 24001,
        work: Work {
            statements: 4,
            fullscan_steps: 1,
            sorts: 1,
            vm_steps: 1001,
            representative_lookups: 61,
            entry_visits: 1,
        },
    };
    assert_eq!(
        budget.exceeded(&observation),
        [
            "rows",
            "wireBytes",
            "statements",
            "fullscanSteps",
            "sorts",
            "vmSteps",
            "representativeLookups",
            "entryVisits"
        ]
    );
    assert!(budget.exceeded(&Observation::default()).is_empty());
}

#[test]
fn series_representatives_preserve_the_first_media_id_without_full_page_scans() {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    let _runtime = runtime.enter();
    let (_temp, library) = performance_tests::fixture(30, 10, 3);
    let db = library.database.lock().unwrap();
    let (_, representatives) =
        catalog::series_with_representatives(&db, catalog::CatalogQuery::default()).unwrap();
    assert_eq!(representatives.len(), 10);
    let index = library.index();
    for (sid, representative) in &representatives {
        let former = index
            .entries
            .values()
            .find(|entry| entry.media.classification.series_id.as_ref() == Some(sid))
            .unwrap();
        assert_eq!(representative.id, former.media.id);
    }
    let (sid, representative) = representatives.first_key_value().unwrap();
    let mut canonical = representative.clone();
    canonical.presentation.summary = Some("Updated canonical presentation".into());
    db.execute(
        "UPDATE media_catalog SET media_json=?1 WHERE id=?2",
        params![serde_json::to_string(&canonical).unwrap(), canonical.id],
    )
    .unwrap();
    let (_, refreshed) =
        catalog::series_with_representatives(&db, catalog::CatalogQuery::default()).unwrap();
    assert_eq!(
        refreshed[sid].presentation.summary.as_deref(),
        Some("Updated canonical presentation")
    );
    assert!(
        library.index().entries[&canonical.id]
            .media
            .presentation
            .summary
            .is_none()
    );
}
