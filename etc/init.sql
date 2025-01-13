create table unstake_requests(
    id serial primary key,
    unstake_id text not null,
    "timestamp" timestamptz not null,
    "user" text not null,
    amount numeric not null,
    processed boolean not null default false
);

create table processed_time_slots(
    id serial primary key,
    "timestamp" timestamptz not null
);

create table payout_records(
  id serial primary key,
  "timestamp" timestamptz not null,
  total_payout_amount numeric not null,
  total_bonded_amount numeric not null
);
create index payout_records_timestamp_idx on payout_records("timestamp");
