"""Add team budget closed_at

Revision ID: f7b3d9a2c6e1
Revises: e3b8c1d5a7f9
"""

from alembic import op
import sqlalchemy as sa


revision = 'f7b3d9a2c6e1'
down_revision = 'e3b8c1d5a7f9'
branch_labels = None
depends_on = None


def upgrade():
    op.add_column('team_budget', sa.Column('closed_at', sa.DateTime(), nullable=True))


def downgrade():
    op.drop_column('team_budget', 'closed_at')
