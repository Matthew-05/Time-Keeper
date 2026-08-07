"""Add budget.closed_at

Revision ID: d9f3a6b8c2e1
Revises: b7e2d4c8a1f5
Create Date: 2026-08-07

The scheduled end date remains intact when a budget is closed manually. The
nullable timestamp records that explicit action and lets allocation stop at
the close date without rewriting the original commitment.
"""
from alembic import op
import sqlalchemy as sa


revision = 'd9f3a6b8c2e1'
down_revision = 'b7e2d4c8a1f5'
branch_labels = None
depends_on = None


def upgrade():
    op.add_column('budget', sa.Column('closed_at', sa.DateTime(), nullable=True))


def downgrade():
    op.drop_column('budget', 'closed_at')
