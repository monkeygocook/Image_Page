
import sqlite3
from pathlib import Path

# เก็บไฟล์ฐานข้อมูลไว้ในโฟลเดอร์เดียวกับ database.py
DB = Path(__file__).resolve().parent / "Userdata.db"


def get_connection():
    conn = sqlite3.connect(DB)
    conn.row_factory = sqlite3.Row
    return conn


def init_db():
    conn = get_connection()

    try:
        cur = conn.cursor()

        # ตารางผู้ใช้
        cur.execute("""
            CREATE TABLE IF NOT EXISTS users (
                email TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                pw TEXT NOT NULL,
                role TEXT NOT NULL,
                created_at TEXT NOT NULL
            )
        """)

        # ตาราง Notes
        cur.execute("""
            CREATE TABLE IF NOT EXISTS notes (
                email TEXT PRIMARY KEY,
                content TEXT NOT NULL DEFAULT '',
                FOREIGN KEY (email) REFERENCES users(email)
            )
        """)

        # ตาราง Preferences
        cur.execute("""
            CREATE TABLE IF NOT EXISTS preferences (
                email TEXT PRIMARY KEY,
                lang TEXT NOT NULL DEFAULT 'th',
                tabs TEXT,
                FOREIGN KEY (email) REFERENCES users(email)
            )
        """)

        conn.commit()
    finally:
        conn.close()
