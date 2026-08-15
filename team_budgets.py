"""Team-budget XLSX import and historical burn-rate reporting.

This module deliberately knows nothing about locally tracked ``Task_Item``
rows. Team budgets are sourced only from the normalized rows of the most
recent workbook import.
"""

from collections import Counter, defaultdict
from datetime import date, datetime, timedelta
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
from io import BytesIO
import math
import posixpath
import re
from xml.etree import ElementTree
from zipfile import BadZipFile, ZipFile


MAIN_NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
REL_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
PACKAGE_REL_NS = 'http://schemas.openxmlformats.org/package/2006/relationships'
NS = {'x': MAIN_NS, 'r': REL_NS, 'p': PACKAGE_REL_NS}
MAX_UNCOMPRESSED_BYTES = 50 * 1024 * 1024
MAX_ZIP_ENTRIES = 2_000
MAX_ROWS = 100_000
TIME_FORMATS = {'decimal_hours', 'clock_duration', 'minutes'}
_CELL_REF = re.compile(r'^([A-Z]+)')
_CLOCK_DURATION = re.compile(r'^(\d+):([0-5]\d)(?::([0-5]\d(?:\.\d+)?))?$')


class XlsxImportError(ValueError):
    """A workbook problem that can be shown directly to the user."""


class _FormulaValue:
    """Marker used so required-column formulas can be rejected explicitly."""

    def __init__(self, coordinate):
        self.coordinate = coordinate


def _xml(root, name):
    try:
        return root.read(name)
    except KeyError as exc:
        raise XlsxImportError('This workbook is missing required XLSX data.') from exc


def _safe_zip(data):
    try:
        workbook = ZipFile(BytesIO(data))
    except (BadZipFile, OSError) as exc:
        raise XlsxImportError('Choose a valid .xlsx workbook.') from exc
    entries = workbook.infolist()
    if len(entries) > MAX_ZIP_ENTRIES:
        workbook.close()
        raise XlsxImportError('That workbook contains too many internal files.')
    if sum(info.file_size for info in entries) > MAX_UNCOMPRESSED_BYTES:
        workbook.close()
        raise XlsxImportError('That workbook expands beyond the 50 MB import limit.')
    return workbook


def _parse_xml(payload, damaged_message):
    if b'<!DOCTYPE' in payload.upper():
        raise XlsxImportError('Workbook XML document types are not supported.')
    try:
        return ElementTree.fromstring(payload)
    except ElementTree.ParseError as exc:
        raise XlsxImportError(damaged_message) from exc


def _shared_strings(workbook):
    try:
        root = _parse_xml(
            workbook.read('xl/sharedStrings.xml'),
            'The workbook shared-string table is damaged.',
        )
    except KeyError:
        return []
    return [
        ''.join(node.text or '' for node in item.findall('.//x:t', NS))
        for item in root.findall('x:si', NS)
    ]


def _workbook_info(workbook):
    root = _parse_xml(
        _xml(workbook, 'xl/workbook.xml'), 'The workbook structure is damaged.'
    )
    rels = _parse_xml(
        _xml(workbook, 'xl/_rels/workbook.xml.rels'),
        'The workbook relationships are damaged.',
    )

    targets = {
        rel.attrib['Id']: rel.attrib['Target']
        for rel in rels.findall('p:Relationship', NS)
    }
    sheets = []
    for sheet in root.findall('x:sheets/x:sheet', NS):
        rel_id = sheet.attrib.get(f'{{{REL_NS}}}id')
        target = targets.get(rel_id)
        if not target:
            continue
        if target.startswith('/'):
            path = target.lstrip('/')
        else:
            path = posixpath.normpath(posixpath.join('xl', target))
        if not path.startswith('xl/'):
            continue
        sheets.append({'name': sheet.attrib.get('name', 'Sheet'), 'path': path})

    workbook_properties = root.find('x:workbookPr', NS)
    date_1904 = (
        workbook_properties is not None
        and workbook_properties.attrib.get('date1904', '').lower() in {'1', 'true'}
    )
    if not sheets:
        raise XlsxImportError('The workbook does not contain a readable worksheet.')
    return sheets, date_1904


def _column_index(reference):
    match = _CELL_REF.match(reference or '')
    if not match:
        return None
    result = 0
    for character in match.group(1):
        result = result * 26 + ord(character) - 64
    return result - 1


def _cell_value(cell, shared_strings):
    if cell.find('x:f', NS) is not None:
        return _FormulaValue(cell.attrib.get('r', 'cell'))
    kind = cell.attrib.get('t')
    if kind == 'inlineStr':
        return ''.join(node.text or '' for node in cell.findall('.//x:t', NS))
    value_node = cell.find('x:v', NS)
    if value_node is None:
        return None
    raw = value_node.text or ''
    if kind == 's':
        try:
            return shared_strings[int(raw)]
        except (ValueError, IndexError) as exc:
            raise XlsxImportError('The workbook contains an invalid shared string.') from exc
    if kind in {'str', 'e'}:
        return raw
    if kind == 'b':
        return raw == '1'
    try:
        return float(raw)
    except ValueError:
        return raw


def _sheet_rows(workbook, path, shared_strings):
    root = _parse_xml(
        _xml(workbook, path), 'The selected worksheet is damaged.'
    )

    rows = []
    for row_node in root.findall('.//x:sheetData/x:row', NS):
        row_number = int(row_node.attrib.get('r', len(rows) + 1))
        values = {}
        for cell in row_node.findall('x:c', NS):
            index = _column_index(cell.attrib.get('r'))
            if index is not None:
                values[index] = _cell_value(cell, shared_strings)
        rows.append((row_number, values))
        if len(rows) > MAX_ROWS + 1:
            raise XlsxImportError(f'Imports are limited to {MAX_ROWS:,} data rows.')
    return rows


def _text(value):
    if value is None:
        return ''
    if isinstance(value, _FormulaValue):
        return ''
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    return str(value).strip()


def _header_data(rows):
    for offset, (row_number, values) in enumerate(rows[:20]):
        if not any(_text(value) for value in values.values()):
            continue
        last = max(values, default=-1)
        headers = [_text(values.get(index)) for index in range(last + 1)]
        return offset, row_number, headers
    raise XlsxImportError('The selected worksheet does not contain a header row.')


def _detect_columns(headers):
    normalized = defaultdict(list)
    for index, header in enumerate(headers):
        normalized[header.casefold()].append(index)
    result = {}
    for name in ('date', 'user', 'time'):
        matches = normalized.get(name, [])
        if len(matches) == 1:
            result[name] = headers[matches[0]]
    return result


def inspect_xlsx(data, sheet_name=None):
    """Return sheet/header metadata and automatically detected columns."""
    with _safe_zip(data) as workbook:
        sheets, _date_1904 = _workbook_info(workbook)
        selected = next((item for item in sheets if item['name'] == sheet_name), None)
        if sheet_name is not None and selected is None:
            raise XlsxImportError('The selected worksheet is not in this workbook.')
        if selected is None:
            selected = sheets[0]
        rows = _sheet_rows(workbook, selected['path'], _shared_strings(workbook))
        _offset, header_row, headers = _header_data(rows)
    detected = _detect_columns(headers)
    return {
        'sheets': [item['name'] for item in sheets],
        'sheet': selected['name'],
        'header_row': header_row,
        'headers': headers,
        'detected_columns': detected,
        'mapping_required': len(detected) != 3,
    }


def _parse_date(value, date_1904):
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        if not math.isfinite(float(value)):
            raise ValueError('date is not finite')
        epoch = date(1904, 1, 1) if date_1904 else date(1899, 12, 30)
        return epoch + timedelta(days=int(float(value)))

    raw = _text(value)
    for pattern in ('%Y-%m-%d', '%m/%d/%Y', '%m/%d/%y', '%Y/%m/%d'):
        try:
            return datetime.strptime(raw, pattern).date()
        except ValueError:
            pass
    try:
        return datetime.fromisoformat(raw).date()
    except ValueError as exc:
        raise ValueError('expected an Excel date or YYYY-MM-DD') from exc


def _parse_seconds(value, time_format):
    if time_format not in TIME_FORMATS:
        raise ValueError('unknown time format')
    if isinstance(value, bool) or value is None:
        raise ValueError('time is blank')

    if time_format == 'clock_duration' and isinstance(value, str):
        match = _CLOCK_DURATION.fullmatch(value.strip())
        if not match:
            raise ValueError('expected H:MM or H:MM:SS')
        seconds = (
            Decimal(match.group(1)) * Decimal(3600)
            + Decimal(match.group(2)) * Decimal(60)
            + Decimal(match.group(3) or 0)
        )
    else:
        try:
            amount = Decimal(str(value).strip())
        except (InvalidOperation, TypeError, ValueError) as exc:
            raise ValueError('time is not numeric') from exc
        if not amount.is_finite():
            raise ValueError('time is not finite')
        if time_format == 'minutes':
            seconds = amount * Decimal(60)
        elif time_format == 'clock_duration':
            seconds = amount * Decimal(86400)
        else:
            seconds = amount * Decimal(3600)

    normalized = int(seconds.quantize(Decimal('1'), rounding=ROUND_HALF_UP))
    if normalized <= 0:
        raise ValueError('time must be greater than zero')
    if normalized > 100000 * 3600:
        raise ValueError('time exceeds 100,000 hours')
    return normalized


def parse_xlsx(data, *, time_format='decimal_hours', column_mapping=None, sheet_name=None):
    """Normalize the selected worksheet into date/user/hour rows."""
    if time_format not in TIME_FORMATS:
        raise XlsxImportError('Choose decimal hours, clock duration, or minutes.')

    with _safe_zip(data) as workbook:
        sheets, date_1904 = _workbook_info(workbook)
        selected = next((item for item in sheets if item['name'] == sheet_name), None)
        if sheet_name is not None and selected is None:
            raise XlsxImportError('The selected worksheet is not in this workbook.')
        if selected is None:
            selected = sheets[0]
        rows = _sheet_rows(workbook, selected['path'], _shared_strings(workbook))
        header_offset, header_row, headers = _header_data(rows)
        mapping = dict(column_mapping or _detect_columns(headers))

        if set(mapping) != {'date', 'user', 'time'}:
            raise XlsxImportError('Map the date, user, and time columns before continuing.')
        if len(set(mapping.values())) != 3:
            raise XlsxImportError('Date, user, and time must use different columns.')
        header_indexes = {header: index for index, header in enumerate(headers)}
        if any(header not in header_indexes for header in mapping.values()):
            raise XlsxImportError('A mapped column is not present in the selected worksheet.')

        parsed = []
        errors = []
        for row_number, values in rows[header_offset + 1:]:
            selected_values = {
                field: values.get(header_indexes[header])
                for field, header in mapping.items()
            }
            if not any(_text(value) for value in selected_values.values()):
                continue
            try:
                formula = next(
                    (value for value in selected_values.values()
                     if isinstance(value, _FormulaValue)),
                    None,
                )
                if formula is not None:
                    raise ValueError(
                        f'{formula.coordinate} contains a formula; paste values before importing'
                    )
                work_date = _parse_date(selected_values['date'], date_1904)
                source_user_id = _text(selected_values['user'])
                if not source_user_id:
                    raise ValueError('user is blank')
                if len(source_user_id) > 200:
                    raise ValueError('user ID exceeds 200 characters')
                seconds = _parse_seconds(selected_values['time'], time_format)
            except ValueError as exc:
                errors.append({'row': row_number, 'error': str(exc)})
                continue
            parsed.append({
                'row': row_number,
                'date': work_date,
                'source_user_id': source_user_id,
                'seconds': seconds,
            })

    return {
        'sheets': [item['name'] for item in sheets],
        'sheet': selected['name'],
        'header_row': header_row,
        'headers': headers,
        'column_mapping': mapping,
        'rows': parsed,
        'errors': errors,
    }


def import_preview(parsed, start_date, end_date, known_source_ids, today=None):
    """Classify normalized rows without mutating the database."""
    today = today or date.today()
    future = Counter(row['date'] for row in parsed['rows'] if row['date'] > today)
    rows = [row for row in parsed['rows'] if row['date'] <= today]
    known = {value.casefold() for value in known_source_ids}
    unique_users = {}
    for row in rows:
        unique_users.setdefault(row['source_user_id'].casefold(), row['source_user_id'])
    users = sorted(unique_users.values(), key=str.casefold)
    unknown = [value for value in users if value.casefold() not in known]
    outside = Counter(
        row['date'] for row in rows
        if row['date'] < start_date or row['date'] > end_date
    )
    dates = [row['date'] for row in rows]
    return {
        'row_count': len(rows),
        'validation_errors': parsed['errors'][:50],
        'validation_error_count': len(parsed['errors']),
        'source_user_ids': users,
        'unknown_user_ids': unknown,
        'date_min': min(dates).isoformat() if dates else None,
        'date_max': max(dates).isoformat() if dates else None,
        'future_row_count': sum(future.values()),
        'future_dates': [
            {'date': day.isoformat(), 'row_count': future[day]}
            for day in sorted(future)
        ],
        'out_of_range_row_count': sum(outside.values()),
        'out_of_range_dates': [
            {'date': day.isoformat(), 'row_count': outside[day]}
            for day in sorted(outside)
        ],
    }


def summarise_team_budget(
    start_date, end_date, members, entries, today=None, closed_at=None
):
    """Summarize an engagement from imported rows using calendar-day burn."""
    today = today or date.today()
    member_rows = list(members)
    entry_rows = list(entries)
    budgeted = sum(float(member['budgeted_hours']) for member in member_rows)
    used_seconds = sum(int(entry['seconds']) for entry in entry_rows)
    used = used_seconds / 3600
    total_days = (end_date - start_date).days + 1
    per_member_used = defaultdict(float)
    per_member_day = defaultdict(lambda: defaultdict(float))
    per_day = defaultdict(float)
    for entry in entry_rows:
        per_member_used[entry['member_id']] += int(entry['seconds'])
        per_member_day[entry['member_id']][entry['date']] += int(entry['seconds'])
        per_day[entry['date']] += int(entry['seconds'])

    def scope_projection(committed_hours, consumed_hours, last_entry_date):
        as_of_date = (
            min(last_entry_date, end_date) if last_entry_date is not None else None
        )
        elapsed = (
            max(1, (as_of_date - start_date).days + 1)
            if as_of_date is not None and as_of_date >= start_date else 0
        )
        projected_hours = (
            consumed_hours * total_days / elapsed if elapsed else 0.0
        )
        elapsed_percent = elapsed / total_days * 100 if total_days else 100.0
        mature = elapsed >= 5 and elapsed_percent >= 20

        if today < start_date:
            scope_status = 'upcoming'
        elif consumed_hours > committed_hours:
            scope_status = 'over'
        elif closed_at is not None or today > end_date:
            scope_status = 'closed'
        elif mature and projected_hours > committed_hours:
            scope_status = 'at_risk'
        else:
            scope_status = 'on_track'

        return {
            'projected_hours': round(projected_hours, 2),
            'projection_as_of': as_of_date.isoformat() if as_of_date else None,
            'projection_mature': mature,
            'elapsed_days': elapsed,
            'percent_elapsed': round(elapsed_percent, 1),
            'status': scope_status,
        }

    entry_dates = [entry['date'] for entry in entry_rows]
    as_of = min(max(entry_dates), end_date) if entry_dates else None
    team_projection = scope_projection(
        budgeted,
        used,
        as_of,
    )

    member_summaries = []
    for member in member_rows:
        member_budget = float(member['budgeted_hours'])
        member_used = per_member_used[member['id']] / 3600
        member_dates = list(per_member_day[member['id']])
        member_summaries.append({
            **member,
            'budgeted_hours': round(member_budget, 2),
            'used_hours': round(member_used, 2),
            'remaining_hours': round(member_budget - member_used, 2),
            'percent_used': round(member_used / member_budget * 100, 1),
            **scope_projection(
                member_budget,
                member_used,
                max(member_dates) if member_dates else None,
            ),
        })

    def burn_series(daily_seconds, committed_hours, last_entry_date):
        series = []
        cumulative = 0.0
        day = start_date
        while day <= end_date:
            cumulative += daily_seconds[day] / 3600
            series.append({
                'date': day.isoformat(),
                'actual': (
                    round(cumulative, 4)
                    if last_entry_date is not None and day <= last_entry_date else None
                ),
                'ideal': round(
                    committed_hours * ((day - start_date).days + 1) / total_days, 4
                ),
                'hours': round(daily_seconds[day] / 3600, 4),
            })
            day += timedelta(days=1)
        return series

    burn = burn_series(per_day, budgeted, as_of)
    member_burn = {}
    for member in member_rows:
        member_days = per_member_day[member['id']]
        member_dates = list(member_days)
        member_as_of = min(max(member_dates), end_date) if member_dates else None
        member_burn[str(member['id'])] = burn_series(
            member_days, float(member['budgeted_hours']), member_as_of
        )

    weekly = defaultdict(float)
    for work_date, hours in per_day.items():
        week_start = work_date - timedelta(days=work_date.weekday())
        weekly[week_start] += hours / 3600

    member_weekly = {}
    for member in member_rows:
        weeks = defaultdict(float)
        for work_date, seconds in per_member_day[member['id']].items():
            week_start = work_date - timedelta(days=work_date.weekday())
            weeks[week_start] += seconds / 3600
        member_weekly[str(member['id'])] = [
            {'week_start': week.isoformat(), 'hours': round(hours, 2)}
            for week, hours in sorted(weeks.items())
        ]

    return {
        'budgeted_hours': round(budgeted, 2),
        'used_hours': round(used, 2),
        'remaining_hours': round(budgeted - used, 2),
        'percent_used': round(used / budgeted * 100, 1) if budgeted else 0.0,
        **team_projection,
        'total_days': total_days,
        'is_active': closed_at is None and start_date <= today <= end_date,
        'is_closed': closed_at is not None or today > end_date,
        'members': member_summaries,
        'burn': burn,
        'member_burn': member_burn,
        'weekly': [
            {'week_start': week.isoformat(), 'hours': round(hours, 2)}
            for week, hours in sorted(weekly.items())
        ],
        'member_weekly': member_weekly,
    }
