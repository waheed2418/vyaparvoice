const API_BASE = "http://127.0.0.1:5000/api";

export interface Customer {
  id: number;
  name: string;
  balance: number;
}

export interface Transaction {
  id: number;
  customer_id: number;
  customer_name: string;
  type: "credit" | "payment";
  amount: number;
  description: string;
  date: string;
}

export interface NewTransaction {
  customerName: string;
  type: "credit" | "payment";
  amount: number;
  description: string;
}

async function request<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${url}`, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.error || `Request failed: ${response.status}`);
  }

  return response.json();
}

export const getCustomers = () => request<Customer[]>("/customers");

export const getTransactions = () => request<Transaction[]>("/transactions");

export const saveTransaction = (transaction: NewTransaction) =>
  request<Transaction>("/transactions", {
    method: "POST",
    body: JSON.stringify(transaction),
  });