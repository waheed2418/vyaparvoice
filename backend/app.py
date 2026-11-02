import os
import sqlite3
from flask import Flask, request, jsonify
from flask_cors import CORS

app = Flask(__name__)
CORS(app)

DATABASE = os.path.join(os.path.dirname(__file__), "vyaparvoice.db")


def get_db():
    connection = sqlite3.connect(DATABASE)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys = ON")
    return connection


def initialize_database():
    with get_db() as db:
        db.execute("""
            CREATE TABLE IF NOT EXISTS customers (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL UNIQUE COLLATE NOCASE
            )
        """)

        db.execute("""
            CREATE TABLE IF NOT EXISTS transactions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                customer_id INTEGER NOT NULL,
                type TEXT NOT NULL CHECK(type IN ('credit', 'payment')),
                amount REAL NOT NULL CHECK(amount > 0),
                description TEXT DEFAULT '',
                date TEXT NOT NULL DEFAULT (DATE('now', 'localtime')),
                FOREIGN KEY (customer_id) REFERENCES customers(id)
            )
        """)


def get_customer_balance(db, customer_id):
    result = db.execute("""
        SELECT
            COALESCE(SUM(
                CASE WHEN type = 'credit' THEN amount ELSE -amount END
            ), 0) AS balance
        FROM transactions
        WHERE customer_id = ?
    """, (customer_id,)).fetchone()

    return float(result["balance"])


def transaction_to_dict(row):
    return {
        "id": row["id"],
        "customer_id": row["customer_id"],
        "customer_name": row["customer_name"],
        "type": row["type"],
        "amount": float(row["amount"]),
        "description": row["description"] or "",
        "date": row["date"],
    }


@app.route("/api/health", methods=["GET"])
def health():
    with get_db() as db:
        db.execute("SELECT 1")

    return jsonify({
        "status": "ok",
        "database": "connected"
    })


@app.route("/api/customers", methods=["GET"])
def get_customers():
    with get_db() as db:
        rows = db.execute("""
            SELECT id, name
            FROM customers
            ORDER BY name COLLATE NOCASE
        """).fetchall()

        customers = []

        for row in rows:
            customers.append({
                "id": row["id"],
                "name": row["name"],
                "balance": get_customer_balance(db, row["id"]),
            })

    return jsonify(customers)


@app.route("/api/transactions", methods=["GET"])
def get_transactions():
    with get_db() as db:
        rows = db.execute("""
            SELECT
                t.id,
                t.customer_id,
                c.name AS customer_name,
                t.type,
                t.amount,
                t.description,
                t.date
            FROM transactions t
            JOIN customers c ON c.id = t.customer_id
            ORDER BY t.date DESC, t.id DESC
        """).fetchall()

    return jsonify([transaction_to_dict(row) for row in rows])


@app.route("/api/transactions", methods=["POST"])
def create_transaction():
    data = request.get_json(silent=True) or {}

    customer_name = str(data.get("customerName", "")).strip()
    transaction_type = data.get("type")
    description = str(data.get("description", "")).strip()

    try:
        amount = float(data.get("amount", 0))
    except (TypeError, ValueError):
        return jsonify({"error": "Amount must be a valid number."}), 400

    if not customer_name:
        return jsonify({"error": "Customer name is required."}), 400

    if transaction_type not in ("credit", "payment"):
        return jsonify({"error": "Type must be credit or payment."}), 400

    if amount <= 0:
        return jsonify({"error": "Amount must be greater than zero."}), 400

    try:
        with get_db() as db:
            db.execute("""
                INSERT INTO customers (name)
                VALUES (?)
                ON CONFLICT(name) DO NOTHING
            """, (customer_name,))

            customer = db.execute("""
                SELECT id, name
                FROM customers
                WHERE name = ? COLLATE NOCASE
            """, (customer_name,)).fetchone()

            cursor = db.execute("""
                INSERT INTO transactions
                    (customer_id, type, amount, description)
                VALUES (?, ?, ?, ?)
            """, (
                customer["id"],
                transaction_type,
                amount,
                description,
            ))

            transaction_id = cursor.lastrowid

            row = db.execute("""
                SELECT
                    t.id,
                    t.customer_id,
                    c.name AS customer_name,
                    t.type,
                    t.amount,
                    t.description,
                    t.date
                FROM transactions t
                JOIN customers c ON c.id = t.customer_id
                WHERE t.id = ?
            """, (transaction_id,)).fetchone()

        return jsonify(transaction_to_dict(row)), 201

    except sqlite3.Error as error:
        app.logger.exception("Database error")
        return jsonify({"error": str(error)}), 500


@app.route("/api/summary", methods=["GET"])
def get_summary():
    with get_db() as db:
        customer_count = db.execute(
            "SELECT COUNT(*) AS count FROM customers"
        ).fetchone()["count"]

        totals = db.execute("""
            SELECT
                COALESCE(SUM(
                    CASE WHEN type = 'credit' THEN amount ELSE 0 END
                ), 0) AS total_credit,
                COALESCE(SUM(
                    CASE WHEN type = 'payment' THEN amount ELSE 0 END
                ), 0) AS total_payments
            FROM transactions
        """).fetchone()

        outstanding = db.execute("""
            SELECT COALESCE(SUM(
                CASE WHEN type = 'credit' THEN amount ELSE -amount END
            ), 0) AS total
            FROM transactions
        """).fetchone()["total"]

    return jsonify({
        "customerCount": customer_count,
        "totalCredit": float(totals["total_credit"]),
        "totalPayments": float(totals["total_payments"]),
        "totalOutstanding": float(outstanding),
    })


if __name__ == "__main__":
    initialize_database()
    app.run(host="127.0.0.1", port=5000, debug=True)