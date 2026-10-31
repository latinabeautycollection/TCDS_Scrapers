# Liquidation 1.1.7 health metric fix

The 1.1.6 run completed all 16 requests and saved 15 records, but then reported a health failure because the newly added price and shipping completeness counters were not initialized. JavaScript produced `NaN` for those counters; JSON serialized the values as `null`, so the health gate could not assess the fields.

Version 1.1.7 initializes each counter defensively, reads `price_type` and `auction_start_time_source` from the normalized attributes when needed, and adds a direct regression test for required fields and pickup-only lots. The previous run's field status remains unverified from its summary because those counters were invalid; verify the output and database after running this release.