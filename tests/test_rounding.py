import unittest
import json
import random
import shutil
import subprocess
from datetime import date, datetime, time, timedelta
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
from unittest.mock import patch

import budgets
import settings
from rounding import round_seconds_to_hours


class RoundingPolicyTests(unittest.TestCase):
    def test_nearest_uses_half_up(self):
        policy = {'interval_minutes': 15, 'direction': 'nearest'}
        self.assertEqual(round_seconds_to_hours(7.5 * 60, policy), 0.25)
        self.assertEqual(round_seconds_to_hours(7 * 60, policy), 0.0)

    def test_up_and_down_use_the_selected_interval(self):
        up = {'interval_minutes': 10, 'direction': 'up'}
        down = {'interval_minutes': 10, 'direction': 'down'}
        self.assertEqual(round_seconds_to_hours(11 * 60, up), 20 / 60)
        self.assertEqual(round_seconds_to_hours(19 * 60, down), 10 / 60)

    def test_disabled_policy_returns_tracked_time(self):
        policy = {
            'enabled': False,
            'interval_minutes': 15,
            'direction': 'up',
        }
        self.assertEqual(round_seconds_to_hours(8 * 60, policy), 8 / 60)

    def test_custom_whole_minute_interval(self):
        policy = {'interval_minutes': 6, 'direction': 'nearest'}
        self.assertEqual(round_seconds_to_hours(8 * 60, policy), 6 / 60)


class SettingsTests(unittest.TestCase):
    def test_rounding_defaults_preserve_existing_behavior(self):
        clean = settings._coerce({})
        self.assertTrue(clean['rounding_enabled'])
        self.assertEqual(clean['rounding_interval_minutes'], 15)
        self.assertEqual(clean['rounding_direction'], 'nearest')

    def test_rounding_settings_validate_custom_policy(self):
        clean = settings._coerce({
            'rounding_enabled': False,
            'rounding_interval_minutes': 7,
            'rounding_direction': 'down',
        })
        self.assertFalse(clean['rounding_enabled'])
        self.assertEqual(clean['rounding_interval_minutes'], 7)
        self.assertEqual(clean['rounding_direction'], 'down')

    def test_preview_settings_does_not_write_and_matches_schedule_semantics(self):
        with TemporaryDirectory() as directory:
            settings_path = Path(directory) / 'settings.json'
            with patch.object(settings, 'SETTINGS_PATH', str(settings_path)):
                preview = settings.preview_settings(
                    {'work_hours_per_day': 6, 'work_days': [0, 2, 4]},
                    effective_date=date(2026, 8, 10),
                )

            self.assertFalse(settings_path.exists())
            self.assertEqual(preview['work_hours_per_day'], 6)
            self.assertEqual(preview['work_days'], [0, 2, 4])
            self.assertEqual(
                preview['work_schedule_history'],
                [
                    {
                        'effective_from': date.min.isoformat(),
                        'hours_per_day': 8,
                        'work_days': [0, 1, 2, 3, 4],
                    },
                    {
                        'effective_from': '2026-08-10',
                        'hours_per_day': 6,
                        'work_days': [0, 2, 4],
                    },
                ],
            )


class BudgetRoundingTests(unittest.TestCase):
    @staticmethod
    def task(
        task_id,
        day,
        start_minute,
        end_minute,
        budget_id=None,
        excluded=False,
    ):
        return SimpleNamespace(
            id=task_id,
            date=day,
            start_time=time(9, start_minute),
            end_time=time(9, end_minute),
            budget_id=budget_id,
            budget_excluded=excluded,
        )

    @staticmethod
    def budget(budget_id, day, hours=10):
        return SimpleNamespace(
            id=budget_id,
            start_date=day,
            end_date=day,
            budgeted_hours=hours,
            closed_at=None,
        )

    @staticmethod
    def second_task(
        task_id,
        day,
        start_second,
        end_second,
        budget_id=None,
    ):
        start_hour, start_remainder = divmod(start_second, 3600)
        start_minute, start_second = divmod(start_remainder, 60)
        end_hour, end_remainder = divmod(end_second, 3600)
        end_minute, end_second = divmod(end_remainder, 60)
        return SimpleNamespace(
            id=task_id,
            date=day,
            start_time=time(9 + start_hour, start_minute, start_second),
            end_time=time(9 + end_hour, end_minute, end_second),
            budget_id=budget_id,
            budget_excluded=False,
        )

    def test_legacy_billable_helper_apportions_complete_client_day(self):
        day = date(2026, 8, 10)
        tasks = [self.task(1, day, 0, 10), self.task(2, day, 10, 20)]
        policy = {'interval_minutes': 15, 'direction': 'nearest'}

        allocated = budgets.billable_hours_by_task(tasks, rounding_policy=policy)

        self.assertAlmostEqual(sum(allocated.values()), 15 / 60)
        self.assertAlmostEqual(allocated[1], allocated[2])

    def test_disabled_rounding_keeps_raw_budget_hours(self):
        day = date(2026, 8, 10)
        tasks = [self.task(1, day, 0, 10), self.task(2, day, 10, 20)]

        allocated = budgets.billable_hours_by_task(
            tasks, rounding_policy={'enabled': False}
        )

        self.assertAlmostEqual(sum(allocated.values()), 20 / 60)

    def test_multi_budget_day_reconciles_with_largest_remainder(self):
        day = date(2026, 8, 10)
        client_budgets = [self.budget(1, day), self.budget(2, day)]
        tasks = [
            self.task(1, day, 0, 10, budget_id=1),
            self.task(2, day, 10, 20, budget_id=2),
        ]

        used, split, _unbudgeted, ledger = budgets.allocation_ledger(
            client_budgets,
            tasks,
            rounding_policy={'interval_minutes': 15, 'direction': 'nearest'},
        )

        self.assertAlmostEqual(sum(used.values()), 0.25)
        self.assertAlmostEqual(used[1], 7.5 / 60)
        self.assertAlmostEqual(used[2], 7.5 / 60)
        self.assertAlmostEqual(split[1][0][1], 10 / 60)
        self.assertAlmostEqual(ledger[0]['rounded_hours'], 0.25)

    def test_adding_entry_redistributes_day_without_changing_raw_entry(self):
        day = date(2026, 8, 10)
        client_budgets = [self.budget(1, day), self.budget(2, day)]
        first = self.task(1, day, 0, 10, budget_id=1)
        policy = {'interval_minutes': 15, 'direction': 'nearest'}

        before, _split, _gap, _days = budgets.allocation_ledger(
            client_budgets, [first], rounding_policy=policy
        )
        after, split, _gap, _days = budgets.allocation_ledger(
            client_budgets,
            [first, self.task(2, day, 10, 20, budget_id=2)],
            rounding_policy=policy,
        )

        self.assertAlmostEqual(before[1], 0.25)
        self.assertAlmostEqual(after[1], 7.5 / 60)
        self.assertAlmostEqual(split[1][0][1], 10 / 60)

    def test_explicit_no_budget_time_participates_in_day_reconciliation(self):
        day = date(2026, 8, 10)
        tasks = [
            self.task(1, day, 0, 10, budget_id=1),
            self.task(2, day, 10, 20, excluded=True),
        ]

        used, _split, unbudgeted, ledger = budgets.allocation_ledger(
            [self.budget(1, day)],
            tasks,
            rounding_policy={'interval_minutes': 15, 'direction': 'nearest'},
        )
        destinations = ledger[0]['destinations']

        self.assertAlmostEqual(
            sum(destination['billable_hours'] for destination in destinations),
            ledger[0]['rounded_hours'],
        )
        self.assertAlmostEqual(used[1], 7.5 / 60)
        self.assertAlmostEqual(
            next(d for d in destinations if d['kind'] == 'no_budget')['billable_hours'],
            7.5 / 60,
        )
        # Explicit exclusion is not an accidental gap in budget coverage.
        self.assertEqual(unbudgeted, 0.0)

    def test_pin_reserves_capacity_before_loose_entry_spills(self):
        day = date(2026, 8, 10)
        first = self.budget(1, day, hours=0.25)
        second = self.budget(2, day, hours=1)
        tasks = [
            self.task(1, day, 0, 10, budget_id=1),
            self.task(2, day, 10, 20),
        ]

        _used, split, _gap, _ledger = budgets.allocation_ledger(
            [first, second],
            tasks,
            rounding_policy={'interval_minutes': 15, 'direction': 'nearest'},
        )

        self.assertEqual(split[1], [(1, 10 / 60, True)])
        # The 20-minute client-day consumes only 15 billable minutes. The pin
        # and loose entry therefore fit A together; raw trace slices must not
        # be compared directly with billable budget headroom.
        self.assertAlmostEqual(split[2][0][1], 10 / 60)
        self.assertEqual(split[2][0][0], 1)
        self.assertEqual(len(split[2]), 1)

    def test_rounded_down_day_uses_billable_headroom(self):
        day = date(2026, 8, 10)
        first = self.budget(1, day, hours=0.25)
        second = self.budget(2, day, hours=1)

        used, split, _gap, _ledger = budgets.allocation_ledger(
            [first, second],
            [self.task(1, day, 0, 20)],
            rounding_policy={'interval_minutes': 15, 'direction': 'nearest'},
        )

        self.assertEqual(round(used[1] * 3600), 900)
        self.assertEqual(round(used[2] * 3600), 0)
        self.assertEqual(split[1], [(1, 20 / 60, False)])

    def test_rounded_up_day_fills_then_spills_billable_seconds(self):
        day = date(2026, 8, 10)
        first = self.budget(1, day, hours=0.25)
        second = self.budget(2, day, hours=1)

        used, split, _gap, _ledger = budgets.allocation_ledger(
            [first, second],
            [self.task(1, day, 0, 16)],
            rounding_policy={'interval_minutes': 15, 'direction': 'up'},
        )

        self.assertEqual(round(used[1] * 3600), 900)
        self.assertEqual(round(used[2] * 3600), 900)
        self.assertEqual(len(split[1]), 2)

    def test_final_destinations_receive_one_largest_remainder_pass(self):
        day = date(2026, 8, 10)
        first = self.budget(1, day, hours=95 / 3600)
        second = self.budget(2, day, hours=1)
        tasks = [
            self.task(1, day, 0, 1, budget_id=1),
            self.task(2, day, 1, 2),
            self.task(3, day, 2, 19),
        ]

        used, _split, _gap, ledger = budgets.allocation_ledger(
            [first, second],
            tasks,
            rounding_policy={'interval_minutes': 15, 'direction': 'nearest'},
        )

        self.assertEqual(round(used[1] * 3600), 95)
        self.assertEqual(round(used[2] * 3600), 805)
        shares = {
            destination['budget_id']: round(destination['billable_hours'] * 3600)
            for destination in ledger[0]['destinations']
        }
        self.assertEqual(shares, {1: 95, 2: 805})

    def test_future_pin_reserves_rounded_share_before_earlier_loose_time(self):
        first_day = date(2026, 8, 10)
        pinned_day = date(2026, 8, 11)
        first = SimpleNamespace(
            id=1,
            start_date=first_day,
            end_date=pinned_day,
            budgeted_hours=0.25,
            closed_at=None,
        )
        second = SimpleNamespace(
            id=2,
            start_date=first_day,
            end_date=pinned_day,
            budgeted_hours=1,
            closed_at=None,
        )
        tasks = [
            self.task(1, first_day, 0, 8),
            self.task(2, pinned_day, 0, 8, budget_id=1),
        ]

        used, split, _gap, ledger = budgets.allocation_ledger(
            [first, second],
            tasks,
            rounding_policy={'interval_minutes': 15, 'direction': 'nearest'},
        )

        self.assertEqual(split[1], [(2, 8 / 60, False)])
        self.assertEqual(split[2], [(1, 8 / 60, True)])
        self.assertAlmostEqual(used[1], 0.25)
        self.assertAlmostEqual(used[2], 0.25)
        pinned_destination = next(
            destination
            for day in ledger if day['date'] == pinned_day
            for destination in day['destinations']
            if destination['budget_id'] == 1
        )
        self.assertAlmostEqual(pinned_destination['billable_hours'], 0.25)

    def test_multiple_future_mixed_pin_days_reserve_exact_seconds(self):
        first_day = date(2026, 1, 1)
        second_day = date(2026, 1, 2)
        third_day = date(2026, 1, 3)
        first = SimpleNamespace(
            id=1,
            start_date=first_day,
            end_date=third_day,
            budgeted_hours=0.01,  # exactly 36 seconds
            closed_at=None,
        )
        second = SimpleNamespace(
            id=2,
            start_date=first_day,
            end_date=third_day,
            budgeted_hours=10,
            closed_at=None,
        )
        tasks = [self.second_task(1, first_day, 0, 1200)]
        for task_id, day in ((2, second_day), (4, third_day)):
            tasks.extend([
                self.second_task(task_id, day, 0, 1, budget_id=1),
                self.second_task(task_id + 1, day, 1, 610, budget_id=2),
            ])

        used, split, _gap, ledger = budgets.allocation_ledger(
            [first, second],
            tasks,
            rounding_policy={'interval_minutes': 15, 'direction': 'nearest'},
        )

        self.assertEqual(round(used[1] * 3600), 36)
        self.assertEqual(round(used[2] * 3600), 2664)
        first_day_shares = {
            destination['budget_id']: round(destination['billable_hours'] * 3600)
            for day in ledger if day['date'] == first_day
            for destination in day['destinations']
        }
        self.assertEqual(first_day_shares, {1: 34, 2: 866})
        self.assertEqual(split[1][0][0], 1)
        self.assertEqual(len(split[1]), 2)

    def test_future_reservations_use_split_final_destinations(self):
        first_day = date(2026, 1, 1)
        second_day = date(2026, 1, 2)
        third_day = date(2026, 1, 3)
        first = SimpleNamespace(
            id=1,
            start_date=first_day,
            end_date=third_day,
            budgeted_hours=0.01,  # exactly 36 seconds
            closed_at=None,
        )
        second = SimpleNamespace(
            id=2,
            start_date=first_day,
            end_date=third_day,
            budgeted_hours=10,
            closed_at=None,
        )
        tasks = [self.second_task(1, first_day, 0, 1200)]
        for task_id, day in ((2, second_day), (5, third_day)):
            excluded_task = self.second_task(task_id + 1, day, 1, 2)
            excluded_task.budget_excluded = True
            tasks.extend([
                self.second_task(task_id, day, 0, 1, budget_id=1),
                excluded_task,
                self.second_task(task_id + 2, day, 2, 601),
            ])

        used, split, _gap, ledger = budgets.allocation_ledger(
            [first, second],
            tasks,
            rounding_policy={'interval_minutes': 15, 'direction': 'nearest'},
        )

        self.assertEqual(round(used[1] * 3600), 36)
        self.assertEqual(round(used[2] * 3600), 2662)
        self.assertEqual(len(split[1]), 2)
        first_day_shares = {
            destination['budget_id']: round(destination['billable_hours'] * 3600)
            for day in ledger if day['date'] == first_day
            for destination in day['destinations']
        }
        self.assertEqual(first_day_shares, {1: 32, 2: 868})
        for day in ledger[1:]:
            shares = {
                (destination['kind'], destination['budget_id']): round(
                    destination['billable_hours'] * 3600
                )
                for destination in day['destinations']
            }
            self.assertEqual(
                shares,
                {
                    ('budget', 1): 2,
                    ('budget', 2): 897,
                    ('no_budget', None): 1,
                },
            )

    def test_mixed_pins_reserve_exact_positive_and_negative_adjustments(self):
        day = date(2026, 8, 10)
        policy = {'interval_minutes': 15, 'direction': 'nearest'}

        for minutes, expected_adjustment in ((4, 7 / 60), (8, -1 / 60)):
            with self.subTest(minutes=minutes):
                used, _split, _gap, ledger = budgets.allocation_ledger(
                    [self.budget(1, day), self.budget(2, day)],
                    [
                        self.task(1, day, 0, minutes, budget_id=1),
                        self.task(2, day, 10, 10 + minutes, budget_id=2),
                    ],
                    rounding_policy=policy,
                )

                self.assertAlmostEqual(used[1], 7.5 / 60)
                self.assertAlmostEqual(used[2], 7.5 / 60)
                self.assertAlmostEqual(
                    ledger[0]['rounding_adjustment_hours'],
                    expected_adjustment,
                )

    def test_day_ledger_reports_positive_and_negative_adjustments(self):
        day = date(2026, 8, 10)
        policy = {'interval_minutes': 15, 'direction': 'nearest'}

        _used, _split, _gap, positive = budgets.allocation_ledger(
            [self.budget(1, day)],
            [self.task(1, day, 0, 8, budget_id=1)],
            now=datetime(2026, 8, 10, 10),
            rounding_policy=policy,
        )
        _used, _split, _gap, negative = budgets.allocation_ledger(
            [self.budget(1, day)],
            [self.task(1, day, 0, 22, budget_id=1)],
            rounding_policy=policy,
        )

        self.assertAlmostEqual(positive[0]['rounding_adjustment_hours'], 7 / 60)
        self.assertAlmostEqual(negative[0]['rounding_adjustment_hours'], -7 / 60)
        self.assertTrue(positive[0]['provisional'])

    def test_mixed_no_budget_reasons_reconcile_in_api_shape(self):
        day = date(2026, 8, 10)
        outside_window = self.budget(1, date(2026, 8, 9))
        tasks = [
            self.task(1, day, 0, 10, excluded=True),
            self.task(2, day, 10, 20),
        ]

        _used, _split, unbudgeted, ledger = budgets.allocation_ledger(
            [outside_window],
            tasks,
            rounding_policy={'interval_minutes': 15, 'direction': 'nearest'},
        )
        [serialized] = budgets.rounding_days_for_budget(ledger, outside_window.id)
        reasons = serialized['no_budget_reasons']

        self.assertEqual(set(reasons), {'coverage_gap', 'excluded'})
        self.assertEqual(reasons['excluded']['task_ids'], [1])
        self.assertEqual(reasons['coverage_gap']['task_ids'], [2])
        self.assertAlmostEqual(reasons['excluded']['raw_hours'], 10 / 60, places=5)
        self.assertAlmostEqual(reasons['coverage_gap']['raw_hours'], 10 / 60, places=5)
        self.assertAlmostEqual(reasons['excluded']['billable_hours'], 7.5 / 60)
        self.assertAlmostEqual(reasons['coverage_gap']['billable_hours'], 7.5 / 60)
        self.assertAlmostEqual(
            sum(reason['billable_hours'] for reason in reasons.values()),
            serialized['no_budget_billable_hours'],
        )
        self.assertEqual(
            sum(reason['billable_seconds'] for reason in reasons.values()),
            serialized['no_budget_billable_seconds'],
        )
        self.assertEqual(reasons['excluded']['billable_seconds'], 450)
        self.assertEqual(reasons['coverage_gap']['billable_seconds'], 450)
        self.assertAlmostEqual(unbudgeted, reasons['coverage_gap']['billable_hours'])


class LedgerReconciliationPropertyTests(unittest.TestCase):
    """Randomised reconciliation, because the example tests can't cover the shape.

    Every named test above pins one behaviour that was got wrong at least once.
    This one pins the property all of them are really about: a client-day is the
    only place rounding happens, and its whole-second billable total is shared
    out completely — nothing invented, nothing lost, at any level of the ledger.
    The seed is fixed so a failure is reproducible rather than a flake.
    """

    NOW = datetime(2026, 8, 10, 23, 59, 59)
    SCENARIOS = 400

    @staticmethod
    def seconds(hours):
        return int(round(hours * 3600))

    @staticmethod
    def task(task_id, day, start_second, duration, budget_id, excluded):
        def clock(value):
            hour, remainder = divmod(value, 3600)
            minute, second = divmod(remainder, 60)
            return time(hour, minute, second)

        return SimpleNamespace(
            id=task_id,
            date=day,
            start_time=clock(start_second),
            end_time=clock(start_second + duration),
            budget_id=budget_id,
            budget_excluded=excluded,
        )

    def scenario(self, rng):
        """A client with awkward budgets, pins, exclusions and coverage gaps."""
        base = date(2026, 8, 3)
        policy = {
            'enabled': rng.random() > 0.1,
            'interval_minutes': rng.choice([1, 5, 6, 10, 15, 20, 30, 60]),
            'direction': rng.choice(['nearest', 'up', 'down']),
        }
        client_budgets = []
        for budget_id in range(1, rng.randint(0, 4) + 1):
            start = base + timedelta(days=rng.randint(0, 3))
            client_budgets.append(SimpleNamespace(
                id=budget_id,
                start_date=start,
                end_date=start + timedelta(days=rng.randint(0, 6)),
                # Zero-hour and fractional budgets on purpose: a budget with no
                # headroom is where spill and reservation arithmetic goes wrong.
                budgeted_hours=rng.choice([0, 0.01, 0.25, 0.5, 1, 2, 5]),
                closed_at=None,
            ))

        tasks = []
        task_id = 0
        for offset in range(rng.randint(1, 6)):
            day = base + timedelta(days=offset)
            cursor = 0
            for _ in range(rng.randint(0, 5)):
                # Durations straddling a rounding boundary (7m30s either side)
                # and zero-length entries, which must still get a destination.
                duration = rng.choice([0, 1, 7, 59, 60, 449, 450, 451, 900, 3600])
                if cursor + duration > 23 * 3600:
                    break
                task_id += 1
                excluded = rng.random() < 0.15
                budget_id = None
                if not excluded and client_budgets and rng.random() < 0.45:
                    budget_id = rng.choice(client_budgets).id
                tasks.append(
                    self.task(task_id, day, cursor, duration, budget_id, excluded)
                )
                cursor += duration + rng.randint(0, 300)
        return client_budgets, tasks, policy

    def assert_reconciles(self, client_budgets, tasks, policy):
        used, split, unbudgeted, ledger = budgets.allocation_ledger(
            client_budgets, tasks, now=self.NOW, rounding_policy=policy
        )

        raw_by_task = {
            task.id: budgets.task_seconds(task, self.NOW) for task in tasks
        }
        day_total = 0
        used_from_ledger = {}
        no_budget_total = 0
        coverage_gap_total = 0

        for client_day in ledger:
            raw_day = sum(
                raw_by_task[task.id] for task in tasks
                if task.date == client_day['date']
            )
            expected = self.seconds(round_seconds_to_hours(raw_day, policy))
            billable = self.seconds(client_day['rounded_hours'])

            # The day is rounded exactly once, by the global policy.
            self.assertEqual(billable, expected, client_day['date'])
            self.assertAlmostEqual(client_day['raw_hours'] * 3600, raw_day, places=6)
            self.assertAlmostEqual(
                client_day['rounding_adjustment_hours'] * 3600,
                billable - raw_day,
                places=6,
            )

            destination_total = 0
            for destination in client_day['destinations']:
                share = self.seconds(destination['billable_hours'])
                # Destination shares are whole seconds and never negative.
                self.assertAlmostEqual(
                    destination['billable_hours'] * 3600, share, places=6
                )
                self.assertGreaterEqual(share, 0)
                self.assertGreaterEqual(destination['raw_hours'], 0)
                destination_total += share

                if destination['kind'] == 'budget':
                    used_from_ledger[destination['budget_id']] = (
                        used_from_ledger.get(destination['budget_id'], 0) + share
                    )
                elif destination['kind'] == 'no_budget':
                    no_budget_total += share
                    reasons = destination['reason_shares']
                    # Explanatory sub-rows still add up to their destination.
                    self.assertEqual(
                        sum(self.seconds(r['billable_hours']) for r in reasons.values()),
                        share,
                    )
                    # A row is labelled with its reason, or honestly "mixed".
                    self.assertEqual(
                        destination['reason'],
                        next(iter(reasons)) if len(reasons) == 1 else 'mixed',
                    )
                    coverage_gap_total += self.seconds(
                        reasons.get('coverage_gap', {}).get('billable_hours', 0)
                    )

            # The day's destinations share out the day's billable total exactly.
            self.assertEqual(destination_total, billable, client_day['date'])
            day_total += billable

        # Budgets plus No-budget account for every rounded second, once.
        self.assertEqual(sum(used_from_ledger.values()) + no_budget_total, day_total)
        for budget_id, hours_used in used.items():
            self.assertEqual(
                self.seconds(hours_used), used_from_ledger.get(budget_id, 0)
            )
        # "Unbudgeted" means a coverage gap, never explicitly excluded time.
        self.assertEqual(self.seconds(unbudgeted), coverage_gap_total)

        # Entries stay raw: rounding belongs to the day, not to the entry.
        for task in tasks:
            self.assertIn(task.id, split)
            self.assertAlmostEqual(
                sum(hours for _b, hours, _p in split[task.id]) * 3600,
                raw_by_task[task.id],
                places=6,
            )

    def test_randomised_client_days_reconcile_exactly(self):
        rng = random.Random(20260810)
        for index in range(self.SCENARIOS):
            client_budgets, tasks, policy = self.scenario(rng)
            if not tasks:
                continue
            with self.subTest(scenario=index, policy=policy):
                self.assert_reconciles(client_budgets, tasks, policy)

    def test_allocation_is_stable_across_identical_runs(self):
        """An allocation that reshuffled between page loads would be untrustable."""
        rng = random.Random(4242)
        for index in range(240):
            client_budgets, tasks, policy = self.scenario(rng)
            if not tasks:
                continue
            with self.subTest(scenario=index):
                first = budgets.allocation_ledger(
                    client_budgets, tasks, now=self.NOW, rounding_policy=policy
                )
                second = budgets.allocation_ledger(
                    client_budgets, tasks, now=self.NOW, rounding_policy=policy
                )
                self.assertEqual(first, second)

    def test_seed_4242_scenario_171_uses_exact_category_reservations(self):
        """The former iterative planner cycled forever on this exact fixture."""
        rng = random.Random(4242)
        for _index in range(172):
            client_budgets, tasks, policy = self.scenario(rng)

        self.assertEqual(
            policy,
            {'enabled': True, 'interval_minutes': 15, 'direction': 'up'},
        )
        used, split, unbudgeted, ledger = budgets.allocation_ledger(
            client_budgets, tasks, now=self.NOW, rounding_policy=policy
        )

        self.assertEqual(
            {budget_id: self.seconds(value) for budget_id, value in used.items()},
            {1: 2251, 2: 1800, 3: 900, 4: 449},
        )
        self.assertEqual(self.seconds(unbudgeted), 0)
        self.assertEqual(
            {
                client_day['date']: {
                    destination['budget_id']: self.seconds(
                        destination['billable_hours']
                    )
                    for destination in client_day['destinations']
                    if destination['kind'] == 'budget'
                }
                for client_day in ledger
            },
            {
                date(2026, 8, 3): {2: 900},
                date(2026, 8, 4): {2: 892, 3: 8},
                date(2026, 8, 5): {1: 2251, 4: 449},
                date(2026, 8, 6): {2: 8, 3: 892},
            },
        )
        self.assertAlmostEqual(
            sum(hours for _budget, hours, _pinned in split[2]) * 3600,
            451,
            places=6,
        )


class BudgetDurationFormattingTests(unittest.TestCase):
    def test_day_group_disclosure_does_not_nest_interactive_controls(self):
        """The info button must not live inside the fold button.

        Asserted structurally rather than on the tooltip's wording: nesting a
        button inside a button is invalid HTML and makes the inner one
        unreachable, and that stays true however the tooltip is phrased.
        """
        source = (
            Path(__file__).resolve().parents[1] / 'static/js/budgets.js'
        ).read_text(encoding='utf-8')
        header = source.split('\n    dayGroupHeader(', 1)[1].split(
            '\n    dayGroupBody(', 1
        )[0]

        self.assertIn('<button type="button"', header)
        self.assertIn('data-day-group="${id}"', header)
        self.assertNotIn('role="button"', header)
        self.assertLess(
            header.index('</button>'),
            header.index('this.insightIcon('),
        )

    @unittest.skipUnless(shutil.which('node'), 'Node.js is required for JS formatting test')
    def test_destination_shares_keep_second_precision(self):
        # Imported by path rather than as a base64 data URL: the module has
        # relative imports of its own now, and a data URL has no base to
        # resolve them against.
        script = """
            import { pathToFileURL } from 'node:url';
            const moduleUrl = pathToFileURL('./static/js/budget_render.js').href;
            const { exactDuration, exactDurationSeconds, headline, meter } = await import(moduleUrl);
            const { insightToSentence } = await import(
                pathToFileURL('./static/js/insight.js').href
            );
            const overByOneSecond = {
                status: 'over',
                used_hours: 1,
                used_seconds: 3601,
                budgeted_hours: 1,
                budgeted_seconds: 3600,
                remaining_hours: 0,
                remaining_seconds: -1,
                over_by: 0,
                over_by_seconds: 1,
                percent_used: 100,
                percent_used_exact: 100.027778,
                percent_elapsed: 50,
            };
            process.stdout.write(JSON.stringify([
                exactDuration(7.5 / 60),
                exactDuration(7.5 / 60),
                exactDuration(15 / 60),
                exactDuration(1 / 3600),
                exactDurationSeconds(450),
                headline(overByOneSecond),
                meter(overByOneSecond),
                insightToSentence(meter(overByOneSecond).match(/data-insight="([^"]*)"/)[1]
                    .replaceAll('&quot;', '"').replaceAll('&amp;', '&')),
            ]));
        """
        result = subprocess.run(
            [
                shutil.which('node'),
                '--input-type=module',
                '--eval',
                script,
            ],
            cwd=Path(__file__).resolve().parents[1],
            check=True,
            capture_output=True,
            text=True,
            encoding='utf-8',
        )

        values = json.loads(result.stdout)
        # Destination shares still carry seconds: a half-minute share is the
        # difference between the day's visible pieces adding up and not.
        self.assertEqual(values[:5], ['7m 30s', '7m 30s', '15m', '1s', '7m 30s'])

        # Summary figures are read to the minute — nobody reconciles a budget
        # to the second, and the seconds were noise around the two numbers
        # anyone reads. What must survive the coarser form is the *fact* of the
        # overage: a badge saying Over next to a magnitude of nothing reads as
        # a bug, so a non-zero amount is floored at "1m" rather than allowed to
        # round away to "0m". That, not the second itself, is the regression
        # this test now catches.
        self.assertEqual(values[5], '1m over budget')
        self.assertIn('tk-meter-overflow', values[6])
        self.assertIn('tabindex="0"', values[6])

        self.assertIn('Used 1h of 1 hrs.', values[7])
        self.assertIn('Over budget 1m.', values[7])
        self.assertIn('Period elapsed 50%.', values[7])
        self.assertNotIn(' | ', values[7])

    @unittest.skipUnless(shutil.which('node'), 'Node.js is required for JS formatting test')
    def test_policy_hours_prints_on_the_rounding_grid(self):
        """Figures derived from rounded time must print on the interval.

        One decimal renders a quarter-hour as "3.3", a figure the 15-minute
        policy could never have produced. Only as many decimals as the number
        needs, though: 3.5 must not become "3.50".

        Nothing is snapped by default — a figure that isn't on the grid is
        printed as it stands rather than moved onto one it was never on. The
        pace sentence opts into snapping and is directional with it: an
        allowance rounds down and an overage rounds up, so neither flatters the
        budget.
        """
        script = """
            import { pathToFileURL } from 'node:url';
            const { budgetDuration, paceNote, policyHours } = await import(
                pathToFileURL('./static/js/budget_render.js').href
            );
            const setPolicy = (enabled, interval) => {
                globalThis.document = { documentElement: { dataset: {
                    roundingEnabled: enabled,
                    roundingIntervalMinutes: String(interval),
                } } };
            };
            const pace = (value) => paceNote(
                { status: 'on_track', required_hours_per_day: value }
            );

            setPolicy('true', 15);
            const quarters = [
                policyHours(3.25),
                policyHours(3.5),
                policyHours(7),
                // Off the grid: printed as it stands, not dragged onto one.
                policyHours(3.2666),
                // A grid value arriving with division noise must not be
                // dragged a whole interval by the downward snap.
                policyHours(3.2499999996, { direction: 'down' }),
                policyHours(3.2666, { direction: 'down' }),
                policyHours(3.2666, { direction: 'up' }),
                policyHours(null),
                pace(3.2666),
                pace(-1.1),
                // The per-budget Used figure and its denominator.
                budgetDuration(
                    { used_hours: 3.25, used_seconds: 11700 },
                    'used_hours', 'used_seconds'
                ),
                // An over-budget card asks for the exact whole-second form.
                // Under a policy there are no stray seconds for it to rescue,
                // so it must stay decimal rather than turn into "41h 30m" in
                // the middle of a card of decimals.
                budgetDuration(
                    { used_hours: 41.5, used_seconds: 149400 },
                    'used_hours', 'used_seconds', { exact: true }
                ),
            ];

            setPolicy('true', 6);
            const sixths = [policyHours(3.3), policyHours(3.2666, { direction: 'down' })];

            setPolicy('false', 15);
            const off = [policyHours(3.2666), pace(3.2666)];

            process.stdout.write(JSON.stringify([quarters, sixths, off]));
        """
        result = subprocess.run(
            [shutil.which('node'), '--input-type=module', '--eval', script],
            cwd=Path(__file__).resolve().parents[1],
            check=True,
            capture_output=True,
            text=True,
            encoding='utf-8',
        )
        quarters, sixths, off = json.loads(result.stdout)

        self.assertEqual(
            quarters,
            [
                '3.25', '3.5', '7', '3.27', '3.25', '3.25', '3.5', '—',
                '3.25 hrs/day left to stay on budget',
                '1.25 hrs/day over for the rest',
                '3.25 hrs.',
                '41.5 hrs.',
            ],
        )
        self.assertEqual(sixths, ['3.3', '3.2'])
        # With rounding off there is no grid, so the house one-decimal form
        # stands and the sentence is unchanged.
        self.assertEqual(off, ['3.3', '3.3 hrs/day left to stay on budget'])


if __name__ == '__main__':
    unittest.main()
