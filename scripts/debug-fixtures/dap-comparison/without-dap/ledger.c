#include "index.h"

#include <inttypes.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define ACCOUNTS 13
#define EPOCHS 48
#define EVENTS_PER_EPOCH 64
#define MAX_EVENTS (EPOCHS * EVENTS_PER_EPOCH)
#define WINDOW 3

typedef struct {
    char key[KEY_LIMIT];
    uint32_t epoch;
    uint8_t account;
    int64_t cents;
} Transfer;

typedef struct {
    Transfer transfer;
    uint8_t active;
} Receipt;

typedef struct {
    int64_t balances[ACCOUNTS];
    Receipt receipts[MAX_EVENTS];
    size_t receipts_used;
} ReferenceBook;

typedef struct {
    int64_t balances[ACCOUNTS];
    ReceiptIndex index;
    uint64_t accepted;
    uint64_t retried;
} PostingBook;

typedef struct {
    Transfer entries[9];
    size_t count;
} DispatchQueue;

static uint32_t random_word(uint32_t *state) {
    uint32_t x = *state;
    x ^= x << 13;
    x ^= x >> 17;
    x ^= x << 5;
    return *state = x;
}

static void append_transfer(Transfer *out, Transfer *history, size_t *used,
                            uint32_t epoch, uint32_t *rng, size_t ordinal) {
    if (ordinal % 4 == 0 && *used > 0) {
        for (size_t tries = 0; tries < *used; ++tries) {
            size_t candidate = random_word(rng) % *used;
            if (history[candidate].epoch + WINDOW > epoch) {
                *out = history[candidate];
                return;
            }
        }
        for (size_t i = *used; i > 0; --i) {
            if (history[i - 1].epoch + WINDOW > epoch) {
                *out = history[i - 1];
                return;
            }
        }
    }
    uint32_t serial = random_word(rng);
    snprintf(out->key, sizeof(out->key), "tr-%08" PRIx32, serial);
    out->epoch = epoch;
    out->account = (uint8_t)(random_word(rng) % ACCOUNTS);
    out->cents = (int64_t)(random_word(rng) % 22001u) - 11000;
    history[(*used)++] = *out;
}

static void reference_expire(ReferenceBook *book, uint32_t epoch) {
    for (size_t i = 0; i < book->receipts_used; ++i) {
        Receipt *receipt = &book->receipts[i];
        if (receipt->active && receipt->transfer.epoch < epoch) receipt->active = 0;
    }
}

static void reference_post(ReferenceBook *book, const Transfer *transfer) {
    for (size_t i = 0; i < book->receipts_used; ++i) {
        const Receipt *receipt = &book->receipts[i];
        if (receipt->active && strcmp(receipt->transfer.key, transfer->key) == 0) return;
    }
    if (book->receipts_used == MAX_EVENTS) abort();
    book->balances[transfer->account] += transfer->cents;
    book->receipts[book->receipts_used++] = (Receipt){.transfer = *transfer, .active = 1};
}

static void posting_post(PostingBook *book, const Transfer *transfer, uint32_t epoch) {
    if (index_contains(&book->index, transfer->key)) {
        ++book->retried;
        return;
    }
    int recorded = index_record(&book->index, transfer->key, epoch);
    if (recorded < 0) {
        fprintf(stderr, "receipt index capacity exceeded\n");
        exit(2);
    }
    book->balances[transfer->account] += transfer->cents;
    ++book->accepted;
}

static void drain(DispatchQueue *queue, PostingBook *actual, ReferenceBook *expected,
                  uint32_t epoch) {
    for (size_t i = 0; i < queue->count; ++i) {
        reference_post(expected, &queue->entries[i]);
        posting_post(actual, &queue->entries[i], epoch);
    }
    queue->count = 0;
}

static void enqueue(DispatchQueue *queue, PostingBook *actual, ReferenceBook *expected,
                    const Transfer *transfer, uint32_t epoch) {
    queue->entries[queue->count++] = *transfer;
    if (queue->count == sizeof(queue->entries) / sizeof(queue->entries[0])) {
        drain(queue, actual, expected, epoch);
    }
}

static uint64_t balance_fingerprint(const int64_t *balances) {
    uint64_t result = UINT64_C(1469598103934665603);
    for (size_t i = 0; i < ACCOUNTS; ++i) {
        uint64_t number = (uint64_t)balances[i];
        result = (result ^ number) * UINT64_C(1099511628211);
    }
    return result;
}

int main(int argc, char **argv) {
    uint32_t seed = UINT32_C(0x4a91c03d);
    if (argc > 2 || (argc == 2 && sscanf(argv[1], "%" SCNu32, &seed) != 1)) {
        fprintf(stderr, "usage: %s [decimal-seed]\n", argv[0]);
        return 2;
    }
    if (seed == 0) seed = 1;
    Transfer history[MAX_EVENTS];
    size_t history_used = 0;
    ReferenceBook expected = {0};
    PostingBook actual = {0};
    DispatchQueue queue = {0};
    index_init(&actual.index);
    for (uint32_t epoch = 0; epoch < EPOCHS; ++epoch) {
        uint32_t oldest = epoch >= WINDOW - 1 ? epoch - (WINDOW - 1) : 0;
        reference_expire(&expected, oldest);
        index_retire_before(&actual.index, oldest);
        for (size_t i = 0; i < EVENTS_PER_EPOCH; ++i) {
            Transfer transfer;
            append_transfer(&transfer, history, &history_used, epoch, &seed, i);
            enqueue(&queue, &actual, &expected, &transfer, epoch);
        }
        drain(&queue, &actual, &expected, epoch);
        uint64_t left = balance_fingerprint(expected.balances);
        uint64_t right = balance_fingerprint(actual.balances);
        if (left != right) {
            fprintf(stderr, "settlement divergence: epoch=%" PRIu32
                            " expected=%016" PRIx64 " actual=%016" PRIx64
                            " accepted=%" PRIu64 " retried=%" PRIu64 "\n",
                    epoch, left, right, actual.accepted, actual.retried);
            return 1;
        }
    }
    printf("settlement verified: %u epochs, %u dispatches, %" PRIu64 " accepted\n",
           EPOCHS, EPOCHS * EVENTS_PER_EPOCH, actual.accepted);
    return 0;
}
