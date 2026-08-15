import unittest
from datetime import date

from flask import Flask

from models import (
    db, Client, TeamBudget, TeamBudgetEntry, TeamBudgetMember,
    TeamBudgetMemberAlias,
)


class TeamBudgetModelTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.app = Flask(__name__)
        cls.app.config.update(
            SQLALCHEMY_DATABASE_URI='sqlite:///:memory:',
            SQLALCHEMY_TRACK_MODIFICATIONS=False,
        )
        db.init_app(cls.app)
        cls.context = cls.app.app_context()
        cls.context.push()
        db.create_all()

    @classmethod
    def tearDownClass(cls):
        db.session.remove()
        db.drop_all()
        cls.context.pop()

    def tearDown(self):
        db.session.rollback()
        for model in (
            TeamBudgetEntry, TeamBudgetMemberAlias, TeamBudgetMember,
            TeamBudget, Client,
        ):
            model.query.delete()
        db.session.commit()

    def test_team_budget_owns_members_aliases_and_entries(self):
        client = Client(name='Acme')
        budget = TeamBudget(
            name='Audit', client=client,
            start_date=date(2026, 8, 1), end_date=date(2026, 8, 31),
        )
        member = TeamBudgetMember(
            team_budget=budget, source_user_id='007',
            display_name='Ada', budgeted_hours=40,
        )
        db.session.add(budget)
        db.session.flush()
        member.aliases.append(TeamBudgetMemberAlias(
            team_budget_id=budget.id, source_user_id='ada@example.com'
        ))
        budget.entries.append(TeamBudgetEntry(
            member=member, work_date=date(2026, 8, 4), time_seconds=9000,
            source_user_id='007', source_row=2,
        ))
        db.session.commit()
        self.assertEqual(TeamBudgetEntry.query.count(), 1)

        db.session.delete(budget)
        db.session.commit()
        self.assertEqual(TeamBudgetMember.query.count(), 0)
        self.assertEqual(TeamBudgetMemberAlias.query.count(), 0)
        self.assertEqual(TeamBudgetEntry.query.count(), 0)


if __name__ == '__main__':
    unittest.main()
