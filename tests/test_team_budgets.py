import io
import unittest
from datetime import date
from html import escape
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile

import team_budgets


ROOT = Path(__file__).resolve().parents[1]


def workbook_bytes(rows, headers=('date', 'user', 'time'), date_1904=False):
    """Build the small OOXML surface the importer consumes."""
    all_rows = [headers, *rows]
    row_xml = []
    for row_number, values in enumerate(all_rows, start=1):
        cells = []
        for column, value in enumerate(values, start=1):
            letters = ''
            number = column
            while number:
                number, remainder = divmod(number - 1, 26)
                letters = chr(65 + remainder) + letters
            coordinate = f'{letters}{row_number}'
            if isinstance(value, tuple) and value[0] == 'formula':
                cells.append(
                    f'<c r="{coordinate}"><f>{escape(value[1])}</f><v>{value[2]}</v></c>'
                )
            elif isinstance(value, str):
                cells.append(
                    f'<c r="{coordinate}" t="inlineStr"><is><t>{escape(value)}</t></is></c>'
                )
            elif value is not None:
                cells.append(f'<c r="{coordinate}"><v>{value}</v></c>')
        row_xml.append(f'<row r="{row_number}">{"".join(cells)}</row>')

    workbook_properties = '<workbookPr date1904="1"/>' if date_1904 else ''
    workbook = (
        '<?xml version="1.0" encoding="UTF-8"?>'
        '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
        'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
        f'{workbook_properties}<sheets><sheet name="Data" sheetId="1" r:id="rId1"/></sheets>'
        '</workbook>'
    )
    relationships = (
        '<?xml version="1.0" encoding="UTF-8"?>'
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        '<Relationship Id="rId1" '
        'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" '
        'Target="worksheets/sheet1.xml"/></Relationships>'
    )
    worksheet = (
        '<?xml version="1.0" encoding="UTF-8"?>'
        '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
        f'<sheetData>{"".join(row_xml)}</sheetData></worksheet>'
    )
    output = io.BytesIO()
    with ZipFile(output, 'w', ZIP_DEFLATED) as archive:
        archive.writestr('xl/workbook.xml', workbook)
        archive.writestr('xl/_rels/workbook.xml.rels', relationships)
        archive.writestr('xl/worksheets/sheet1.xml', worksheet)
    return output.getvalue()


class WorkbookImportTests(unittest.TestCase):
    def test_committed_sample_has_expected_import_headers(self):
        data = (ROOT / 'samples' / 'sample_team_entries.xlsx').read_bytes()
        inspected = team_budgets.inspect_xlsx(data)
        self.assertEqual(inspected['headers'], ['date', 'user', 'time'])
        self.assertEqual(
            inspected['detected_columns'],
            {'date': 'date', 'user': 'user', 'time': 'time'},
        )
        self.assertFalse(inspected['mapping_required'])

    def test_decimal_hours_are_normalized_to_integer_seconds(self):
        parsed = team_budgets.parse_xlsx(
            workbook_bytes([('2026-08-04', '007', 2.5)])
        )
        self.assertEqual(parsed['rows'][0]['seconds'], 9000)
        self.assertEqual(parsed['rows'][0]['source_user_id'], '007')
        self.assertEqual(parsed['rows'][0]['date'], date(2026, 8, 4))

    def test_minutes_and_both_clock_duration_shapes_are_supported(self):
        minute = team_budgets.parse_xlsx(
            workbook_bytes([('2026-08-04', 'A', 90)]), time_format='minutes'
        )
        numeric_duration = team_budgets.parse_xlsx(
            workbook_bytes([('2026-08-04', 'A', 0.125)]),
            time_format='clock_duration',
        )
        text_duration = team_budgets.parse_xlsx(
            workbook_bytes([('2026-08-04', 'A', '2:30')]),
            time_format='clock_duration',
        )
        self.assertEqual(minute['rows'][0]['seconds'], 5400)
        self.assertEqual(numeric_duration['rows'][0]['seconds'], 10800)
        self.assertEqual(text_duration['rows'][0]['seconds'], 9000)

    def test_excel_serial_dates_follow_the_workbook_epoch(self):
        serial = (date(2026, 8, 4) - date(1904, 1, 1)).days
        parsed = team_budgets.parse_xlsx(
            workbook_bytes([(serial, 'A', 1)], date_1904=True)
        )
        self.assertEqual(parsed['rows'][0]['date'], date(2026, 8, 4))

    def test_manual_mapping_is_used_when_canonical_headers_are_absent(self):
        data = workbook_bytes(
            [('2026-08-04', 'A', 1)], headers=('Worked', 'Person', 'Hours')
        )
        self.assertTrue(team_budgets.inspect_xlsx(data)['mapping_required'])
        parsed = team_budgets.parse_xlsx(
            data,
            column_mapping={'date': 'Worked', 'user': 'Person', 'time': 'Hours'},
        )
        self.assertEqual(len(parsed['rows']), 1)

    def test_missing_selected_sheet_is_not_silently_replaced(self):
        with self.assertRaisesRegex(team_budgets.XlsxImportError, 'selected worksheet'):
            team_budgets.inspect_xlsx(workbook_bytes([]), sheet_name='Missing')

    def test_formula_in_a_required_column_is_reported_by_row(self):
        parsed = team_budgets.parse_xlsx(
            workbook_bytes([('2026-08-04', 'A', ('formula', '1+1', 2))])
        )
        self.assertEqual(parsed['rows'], [])
        self.assertEqual(parsed['errors'][0]['row'], 2)
        self.assertIn('formula', parsed['errors'][0]['error'])

    def test_preview_lists_unknown_users_and_outside_dates(self):
        parsed = team_budgets.parse_xlsx(workbook_bytes([
            ('2026-07-31', 'Known', 1),
            ('2026-08-04', 'New', 2),
            ('2026-09-01', 'new', 3),
        ]))
        preview = team_budgets.import_preview(
            parsed, date(2026, 8, 1), date(2026, 8, 31), {'known'},
            today=date(2026, 9, 30),
        )
        self.assertEqual(preview['unknown_user_ids'], ['New'])
        self.assertEqual(preview['out_of_range_row_count'], 2)
        self.assertEqual(
            [item['date'] for item in preview['out_of_range_dates']],
            ['2026-07-31', '2026-09-01'],
        )

    def test_preview_excludes_future_rows_from_users_dates_and_range(self):
        parsed = team_budgets.parse_xlsx(workbook_bytes([
            ('2026-08-10', 'Historical', 1),
            ('2026-08-16', 'Future', 2),
        ]))
        preview = team_budgets.import_preview(
            parsed, date(2026, 8, 1), date(2026, 8, 31), set(),
            today=date(2026, 8, 15),
        )
        self.assertEqual(preview['row_count'], 1)
        self.assertEqual(preview['source_user_ids'], ['Historical'])
        self.assertEqual(preview['date_max'], '2026-08-10')
        self.assertEqual(preview['future_row_count'], 1)
        self.assertEqual(
            preview['future_dates'],
            [{'date': '2026-08-16', 'row_count': 1}],
        )


class TeamBudgetSummaryTests(unittest.TestCase):
    def test_totals_members_projection_and_burn_reconcile(self):
        members = [
            {'id': 1, 'name': 'Ada', 'budgeted_hours': 20},
            {'id': 2, 'name': 'Grace', 'budgeted_hours': 30},
        ]
        entries = [
            {'member_id': 1, 'date': date(2026, 8, 1), 'seconds': 5 * 3600},
            {'member_id': 2, 'date': date(2026, 8, 5), 'seconds': 10 * 3600},
        ]
        summary = team_budgets.summarise_team_budget(
            date(2026, 8, 1), date(2026, 8, 10), members, entries,
            today=date(2026, 8, 6),
        )
        self.assertEqual(summary['budgeted_hours'], 50)
        self.assertEqual(summary['used_hours'], 15)
        self.assertEqual(summary['remaining_hours'], 35)
        self.assertEqual(summary['projected_hours'], 30)
        self.assertEqual(summary['projection_as_of'], '2026-08-05')
        self.assertEqual(summary['members'][0]['used_hours'], 5)
        self.assertEqual(summary['members'][1]['used_hours'], 10)
        self.assertEqual(summary['members'][0]['projected_hours'], 50)
        self.assertEqual(summary['members'][1]['projected_hours'], 20)
        self.assertEqual(summary['members'][1]['projection_as_of'], '2026-08-05')
        self.assertEqual(summary['burn'][4]['actual'], 15)
        self.assertIsNone(summary['burn'][5]['actual'])
        self.assertEqual(summary['member_burn']['1'][0]['actual'], 5)
        self.assertIsNone(summary['member_burn']['1'][1]['actual'])
        self.assertEqual(summary['member_burn']['2'][4]['actual'], 10)
        self.assertEqual(summary['member_burn']['2'][4]['ideal'], 15)
        self.assertEqual(sum(week['hours'] for week in summary['weekly']), 15)
        self.assertEqual(
            sum(week['hours'] for week in summary['member_weekly']['1']),
            5,
        )
        self.assertEqual(
            sum(week['hours'] for week in summary['member_weekly']['2']),
            10,
        )

    def test_over_budget_status_wins_after_period_ends(self):
        summary = team_budgets.summarise_team_budget(
            date(2026, 8, 1), date(2026, 8, 2),
            [{'id': 1, 'name': 'Ada', 'budgeted_hours': 1}],
            [{'member_id': 1, 'date': date(2026, 8, 1), 'seconds': 3601}],
            today=date(2026, 9, 1),
        )
        self.assertEqual(summary['status'], 'over')
        self.assertTrue(summary['is_closed'])


if __name__ == '__main__':
    unittest.main()
