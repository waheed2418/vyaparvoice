import { useEffect, useMemo, useState } from "react";
import {
  getCustomers,
  getTransactions,
  saveTransaction,
  type Customer,
  type Transaction,
} from "./api";
import "./App.css";

type DateFilter = "today" | "7days" | "30days" | "1year" | "all";

function formatMoney(value: number) {
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: 2,
  }).format(value);
}

function formatDate(dateString: string) {
  if (!dateString) return "—";

  const date = new Date(`${dateString.slice(0, 10)}T00:00:00`);
  return date.toLocaleDateString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

function getDateCutoff(filter: DateFilter): Date | null {
  const now = new Date();
  const cutoff = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  if (filter === "today") return cutoff;

  if (filter === "7days") {
    cutoff.setDate(cutoff.getDate() - 6);
    return cutoff;
  }

  if (filter === "30days") {
    cutoff.setDate(cutoff.getDate() - 29);
    return cutoff;
  }

  if (filter === "1year") {
    cutoff.setFullYear(cutoff.getFullYear() - 1);
    return cutoff;
  }

  return null;
}

function downloadCSV(transactions: Transaction[]) {
  const headers = [
    "Date",
    "Customer",
    "Type",
    "Amount",
    "Description",
  ];

  const rows = transactions.map((transaction) => [
    transaction.date,
    transaction.customer_name,
    transaction.type,
    transaction.amount,
    transaction.description,
  ]);

  const escapeCSV = (value: unknown) =>
    `"${String(value ?? "").replace(/"/g, '""')}"`;

  const csv = [
    headers.map(escapeCSV).join(","),
    ...rows.map((row) => row.map(escapeCSV).join(",")),
  ].join("\r\n");

  const blob = new Blob(["\uFEFF", csv], {
    type: "text/csv;charset=utf-8;",
  });

  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");

  link.href = url;
  link.download = "vyaparvoice-transactions.csv";
  document.body.appendChild(link);
  link.click();
  link.remove();

  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export default function App() {
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [transactions, setTransactions] = useState<Transaction[]>([]);

  const [customerName, setCustomerName] = useState("");
  const [amount, setAmount] = useState("");
  const [description, setDescription] = useState("");
  const [type, setType] = useState<"credit" | "payment">("credit");

  const [search, setSearch] = useState("");
  const [dateFilter, setDateFilter] = useState<DateFilter>("all");
  const [customerFilter, setCustomerFilter] = useState("all");

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [listening, setListening] = useState(false);
  const [message, setMessage] = useState("");

  async function loadData() {
    try {
      const [customerData, transactionData] = await Promise.all([
        getCustomers(),
        getTransactions(),
      ]);

      setCustomers(customerData);
      setTransactions(transactionData);
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : "Could not load data. Check that the backend is running.",
      );
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadData();
  }, []);

  const totalCredit = transactions
    .filter((transaction) => transaction.type === "credit")
    .reduce((sum, transaction) => sum + Number(transaction.amount), 0);

  const totalPayments = transactions
    .filter((transaction) => transaction.type === "payment")
    .reduce((sum, transaction) => sum + Number(transaction.amount), 0);

  const totalOutstanding = customers.reduce(
    (sum, customer) => sum + Number(customer.balance),
    0,
  );

  const filteredTransactions = useMemo(() => {
    const cutoff = getDateCutoff(dateFilter);
    const normalizedSearch = search.trim().toLowerCase();

    return [...transactions]
      .filter((transaction) => {
        const transactionDate = new Date(
          `${transaction.date.slice(0, 10)}T00:00:00`,
        );

        const matchesDate = !cutoff || transactionDate >= cutoff;
        const matchesCustomer =
          customerFilter === "all" ||
          String(transaction.customer_id) === customerFilter;

        const matchesSearch =
          !normalizedSearch ||
          transaction.customer_name.toLowerCase().includes(normalizedSearch) ||
          transaction.description.toLowerCase().includes(normalizedSearch);

        return matchesDate && matchesCustomer && matchesSearch;
      })
      .sort((a, b) => {
        const dateDifference = b.date.localeCompare(a.date);
        return dateDifference || b.id - a.id;
      });
  }, [transactions, dateFilter, customerFilter, search]);

  function startVoiceInput() {
    const SpeechRecognition =
      (window as any).SpeechRecognition ||
      (window as any).webkitSpeechRecognition;

    if (!SpeechRecognition) {
      setMessage("Voice input is not supported in this browser. Try Chrome.");
      return;
    }

    const recognition = new SpeechRecognition();
    recognition.lang = "en-IN";
    recognition.interimResults = false;
    recognition.maxAlternatives = 1;

    setListening(true);
    setMessage("");

    recognition.onresult = (event: any) => {
      const transcript = event.results[0][0].transcript;
      const lowerTranscript = transcript.toLowerCase();

      const amountMatch = transcript.match(
        /\d+(?:,\d{3})*(?:\.\d+)?/,
      );

      if (amountMatch) {
        setAmount(amountMatch[0].replace(/,/g, ""));
      }

      if (
        lowerTranscript.includes("payment") ||
        lowerTranscript.includes("paid") ||
        lowerTranscript.includes("received")
      ) {
        setType("payment");
      } else if (
        lowerTranscript.includes("credit") ||
        lowerTranscript.includes("sale")
      ) {
        setType("credit");
      }

      const cleanedDescription = transcript
        .replace(/\d+(?:,\d{3})*(?:\.\d+)?/, "")
        .replace(/\b(credit|payment|paid|received|sale)\b/gi, "")
        .trim();

      if (cleanedDescription) {
        setDescription(cleanedDescription);
      }

      setMessage(`Voice captured: "${transcript}"`);
    };

    recognition.onerror = () => {
      setMessage("Voice input failed. Please try again.");
      setListening(false);
    };

    recognition.onend = () => setListening(false);

    recognition.start();
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setMessage("");

    const parsedAmount = Number(amount);

    if (!customerName.trim()) {
      setMessage("Please enter a customer name.");
      return;
    }

    if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
      setMessage("Please enter a valid amount greater than zero.");
      return;
    }

    setSaving(true);

    try {
      await saveTransaction({
        customerName: customerName.trim(),
        type,
        amount: parsedAmount,
        description: description.trim(),
      });

      setCustomerName("");
      setAmount("");
      setDescription("");
      setType("credit");

      await loadData();
      setMessage("Transaction saved successfully.");
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : "Could not save transaction. Check the backend.",
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">
          <div className="brand-icon">V</div>
          <div>
            <h1>VyaparVoice</h1>
            <p>Simple business ledger</p>
          </div>
        </div>
        <span className="database-status">
          <span className="status-dot" />
          SQLite database
        </span>
      </header>

      <main className="dashboard">
        <section className="welcome">
          <div>
            <p className="eyebrow">YOUR BUSINESS OVERVIEW</p>
            <h2>Good business starts with clear records.</h2>
            <p className="muted">
              Track customer credit, payments, and outstanding balances.
            </p>
          </div>
        </section>

        <section className="summary-grid">
          <article className="summary-card">
            <p>Total outstanding</p>
            <h3>{formatMoney(totalOutstanding)}</h3>
            <span>Amount customers owe</span>
          </article>

          <article className="summary-card">
            <p>Total credit sales</p>
            <h3>{formatMoney(totalCredit)}</h3>
            <span>Recorded credit transactions</span>
          </article>

          <article className="summary-card">
            <p>Payments received</p>
            <h3>{formatMoney(totalPayments)}</h3>
            <span>Recorded customer payments</span>
          </article>

          <article className="summary-card">
            <p>Total customers</p>
            <h3>{customers.length}</h3>
            <span>Customers in your ledger</span>
          </article>
        </section>

        <section className="content-grid">
          <section className="panel transaction-form-panel">
            <div className="panel-heading">
              <div>
                <p className="eyebrow">NEW RECORD</p>
                <h2>Add transaction</h2>
              </div>
              <button
                type="button"
                className={`voice-button ${listening ? "listening" : ""}`}
                onClick={startVoiceInput}
                disabled={listening}
              >
                {listening ? "Listening…" : "🎙 Voice entry"}
              </button>
            </div>

            <form onSubmit={handleSubmit}>
              <label htmlFor="customerName">Customer name</label>
              <input
                id="customerName"
                value={customerName}
                onChange={(event) => setCustomerName(event.target.value)}
                placeholder="Enter customer name"
              />

              <label htmlFor="transactionType">Transaction type</label>
              <select
                id="transactionType"
                value={type}
                onChange={(event) =>
                  setType(event.target.value as "credit" | "payment")
                }
              >
                <option value="credit">Credit sale</option>
                <option value="payment">Payment received</option>
              </select>

              <label htmlFor="amount">Amount (₹)</label>
              <input
                id="amount"
                type="number"
                min="0.01"
                step="0.01"
                value={amount}
                onChange={(event) => setAmount(event.target.value)}
                placeholder="0.00"
              />

              <label htmlFor="description">Description</label>
              <input
                id="description"
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                placeholder="What was this transaction for?"
              />

              {message && (
                <p className="form-message" role="status">
                  {message}
                </p>
              )}

              <button className="primary-button" type="submit" disabled={saving}>
                {saving ? "Saving…" : "Save transaction"}
              </button>
            </form>
          </section>

          <section className="panel customers-panel">
            <div className="panel-heading">
              <div>
                <p className="eyebrow">CUSTOMER LEDGER</p>
                <h2>Customer balances</h2>
              </div>
              <span className="count-badge">{customers.length}</span>
            </div>

            {loading ? (
              <p className="empty-state">Loading customers…</p>
            ) : customers.length === 0 ? (
              <p className="empty-state">
                No customers yet. Add your first transaction to create one.
              </p>
            ) : (
              <div className="customer-list">
                {customers.map((customer) => (
                  <div className="customer-row" key={customer.id}>
                    <div className="customer-avatar">
                      {customer.name.charAt(0).toUpperCase()}
                    </div>
                    <div className="customer-details">
                      <strong>{customer.name}</strong>
                      <span>Customer #{customer.id}</span>
                    </div>
                    <strong
                      className={
                        customer.balance > 0
                          ? "balance-positive"
                          : "balance-neutral"
                      }
                    >
                      {formatMoney(customer.balance)}
                    </strong>
                  </div>
                ))}
              </div>
            )}
          </section>
        </section>

        <section className="panel activity-panel">
          <div className="panel-heading activity-heading">
            <div>
              <p className="eyebrow">LEDGER HISTORY</p>
              <h2>Transactions &amp; recent activity</h2>
              <p className="muted">
                Search and filter your saved transaction records.
              </p>
            </div>

            <button
              type="button"
              className="secondary-button"
              onClick={() => downloadCSV(filteredTransactions)}
              disabled={filteredTransactions.length === 0}
            >
              ↓ Export CSV
            </button>
          </div>

          <div className="filters">
            <input
              aria-label="Search transactions"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search customer or description…"
            />

            <select
              aria-label="Filter by customer"
              value={customerFilter}
              onChange={(event) => setCustomerFilter(event.target.value)}
            >
              <option value="all">All customers</option>
              {customers.map((customer) => (
                <option key={customer.id} value={String(customer.id)}>
                  {customer.name}
                </option>
              ))}
            </select>

            <select
              aria-label="Filter by date"
              value={dateFilter}
              onChange={(event) =>
                setDateFilter(event.target.value as DateFilter)
              }
            >
              <option value="all">All time</option>
              <option value="today">Today</option>
              <option value="7days">Last 7 days</option>
              <option value="30days">Last 30 days</option>
              <option value="1year">Last 1 year</option>
            </select>
          </div>

          <div className="table-wrapper">
            <table>
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Customer</th>
                  <th>Type</th>
                  <th>Description</th>
                  <th className="amount-column">Amount</th>
                </tr>
              </thead>
              <tbody>
                {filteredTransactions.map((transaction) => (
                  <tr key={transaction.id}>
                    <td>{formatDate(transaction.date)}</td>
                    <td className="table-customer">
                      {transaction.customer_name}
                    </td>
                    <td>
                      <span
                        className={`transaction-badge ${transaction.type}`}
                      >
                        {transaction.type === "credit"
                          ? "Credit sale"
                          : "Payment"}
                      </span>
                    </td>
                    <td>{transaction.description || "—"}</td>
                    <td
                      className={`amount-column ${
                        transaction.type === "credit"
                          ? "credit-amount"
                          : "payment-amount"
                      }`}
                    >
                      {transaction.type === "credit" ? "+" : "−"}
                      {formatMoney(Number(transaction.amount))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            {!loading && filteredTransactions.length === 0 && (
              <p className="empty-state">
                No transactions match your filters.
              </p>
            )}
          </div>

          <div className="table-footer">
            Showing {filteredTransactions.length} of {transactions.length}{" "}
            transactions
          </div>
        </section>

        <footer className="footer">
          VyaparVoice · Your records stay in your local SQLite database.
        </footer>
      </main>
    </div>
  );
}