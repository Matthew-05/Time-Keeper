"""Add per-budget at-risk threshold

Revision ID: f2a4c7d9e1b3
Revises: f1c2d3e4a5b6
Create Date: 2026-08-07

Existing and new budgets default to a 10% projected overage threshold.
"""
from alembic import op
import sqlalchemy as sa


revision = 'f2a4c7d9e1b3'
down_revision = 'f1c2d3e4a5b6'
branch_labels = None
depends_on = None


def upgrade():
    op.add_column(
        'budget',
        sa.Column(
            'risk_threshold_percent',
            sa.Float(),
            nullable=False,
            server_default='10',
        ),
    )


def downgrade():
    op.drop_column('budget', 'risk_threshold_percent')
