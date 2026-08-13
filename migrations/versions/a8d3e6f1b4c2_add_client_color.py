"""Add stored client colors

Revision ID: a8d3e6f1b4c2
Revises: f2a4c7d9e1b3
Create Date: 2026-08-13

Every existing client receives an independently generated color. The server
default is only a database-level safety net; normal application inserts use the
model's random callable or an explicitly selected color.
"""

import colorsys
import random

from alembic import op
import sqlalchemy as sa


revision = 'a8d3e6f1b4c2'
down_revision = 'f2a4c7d9e1b3'
branch_labels = None
depends_on = None


def _random_color():
    hue = random.SystemRandom().random()
    red, green, blue = colorsys.hls_to_rgb(hue, 0.58, 0.62)
    return '#{:02x}{:02x}{:02x}'.format(
        round(red * 255), round(green * 255), round(blue * 255)
    )


def upgrade():
    connection = op.get_bind()
    columns = {column['name'] for column in sa.inspect(connection).get_columns('client')}
    added = 'color' not in columns
    if added:
        fallback = _random_color()
        op.add_column(
            'client',
            sa.Column(
                'color',
                sa.String(length=7),
                nullable=False,
                server_default=fallback,
            ),
        )

    where = '' if added else " WHERE color IS NULL OR color = ''"
    client_ids = connection.execute(
        sa.text(f'SELECT id FROM client{where}')
    ).fetchall()
    for row in client_ids:
        connection.execute(
            sa.text('UPDATE client SET color = :color WHERE id = :id'),
            {'color': _random_color(), 'id': row[0]},
        )


def downgrade():
    connection = op.get_bind()
    columns = {column['name'] for column in sa.inspect(connection).get_columns('client')}
    if 'color' in columns:
        with op.batch_alter_table('client') as batch:
            batch.drop_column('color')
