#include "index.h"

#include <string.h>

static size_t start_slot(const char *key) {
    uint32_t h = 2166136261u;
    for (const unsigned char *p = (const unsigned char *)key; *p; ++p) {
        h = (h ^ *p) * 16777619u;
    }
    return (size_t)(h % INDEX_CAPACITY);
}

void index_init(ReceiptIndex *index) {
    memset(index, 0, sizeof(*index));
}

int index_contains(const ReceiptIndex *index, const char *key) {
    size_t start = start_slot(key);
    for (size_t distance = 0; distance < INDEX_CAPACITY; ++distance) {
        const IndexSlot *slot = &index->slots[(start + distance) % INDEX_CAPACITY];
        if (slot->state == 0) return 0;
        if (slot->state == 1 && strcmp(slot->key, key) == 0) return 1;
    }
    return 0;
}

int index_record(ReceiptIndex *index, const char *key, uint32_t epoch) {
    size_t start = start_slot(key);
    size_t reusable = INDEX_CAPACITY;
    for (size_t distance = 0; distance < INDEX_CAPACITY; ++distance) {
        size_t at = (start + distance) % INDEX_CAPACITY;
        IndexSlot *slot = &index->slots[at];
        if (slot->state == 2 && reusable == INDEX_CAPACITY) reusable = at;
        if (slot->state == 0) {
            if (reusable != INDEX_CAPACITY) slot = &index->slots[reusable];
            if (slot->state == 2) --index->retired;
            slot->state = 1;
            slot->epoch = epoch;
            strncpy(slot->key, key, KEY_LIMIT - 1);
            slot->key[KEY_LIMIT - 1] = '\0';
            ++index->live;
            return 1;
        }
    }
    if (reusable == INDEX_CAPACITY) return -1;
    IndexSlot *slot = &index->slots[reusable];
    --index->retired;
    slot->state = 1;
    slot->epoch = epoch;
    strncpy(slot->key, key, KEY_LIMIT - 1);
    slot->key[KEY_LIMIT - 1] = '\0';
    ++index->live;
    return 1;
}

void index_retire_before(ReceiptIndex *index, uint32_t epoch) {
    for (size_t i = 0; i < INDEX_CAPACITY; ++i) {
        IndexSlot *slot = &index->slots[i];
        if (slot->state == 1 && slot->epoch < epoch) {
            slot->state = 2;
            --index->live;
            ++index->retired;
        }
    }
}
