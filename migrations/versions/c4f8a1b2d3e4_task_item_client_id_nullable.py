"""task__item.client_id nullable for client deletion

Revision ID: c4f8a1b2d3e4
Revises: 987b53a0bb7b
Create Date: 2026-05-11

"""
from alembic import op
import sqlalchemy as sa


revision = 'c4f8a1b2d3e4'
down_revision = '987b53a0bb7b'
branch_labels = None
depends_on = None


def upgrade():
    with op.batch_alter_table('task__item', schema=None) as batch_op:
        batch_op.alter_column(
            'client_id',
            existing_type=sa.INTEGER(),
            nullable=True,
        )


def downgrade():
    with op.batch_alter_table('task__item', schema=None) as batch_op:
        batch_op.alter_column(
            'client_id',
            existing_type=sa.INTEGER(),
            nullable=False,
        )
